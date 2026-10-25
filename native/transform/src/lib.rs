use std::path::Path;

use napi_derive::napi;
use oxc::{
    allocator::Allocator,
    ast::AstKind,
    ast_visit::Visit,
    codegen::{Codegen, CodegenOptions},
    parser::Parser,
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{TransformOptions, Transformer},
};
use serde::Deserialize;

// Change this identity whenever options, eligibility, or output semantics change.
// The host includes it in transform cache keys without eagerly loading the addon.
const BACKEND_VERSION: &str = "oxc-0.155.0:tsx-native-3";

#[napi]
pub fn backend_version() -> &'static str {
    BACKEND_VERSION
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    target: String,
    lang: String,
    source_type: String,
    source_map: bool,
    only_remove_type_imports: bool,
    use_define_for_class_fields: bool,
    // The host supplies the complete mapping, but JSX currently takes the
    // compatibility backend. Keeping this field explicit rejects misspelled options.
    #[serde(default)]
    jsx: Option<serde_json::Value>,
    #[serde(default)]
    banner: Option<String>,
    #[serde(default)]
    footer: Option<String>,
}

#[napi(object)]
pub struct TransformOutput {
    pub code: String,
    /// Serialized source map. The host applies its sourcesContent policy.
    pub map: String,
}

// Eligibility is checked on the original AST, before TypeScript erasure can lose
// information. The same AST and allocator then flow through semantic analysis,
// transformation and code generation; no text scanner or second parser is used.
struct Eligibility {
    supported: bool,
    use_define_for_class_fields: bool,
    commonjs: bool,
    function_depth: u32,
    typescript: bool,
    only_remove_type_imports: bool,
}

impl<'a> Visit<'a> for Eligibility {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => {
                self.function_depth += 1;
            }
            AstKind::ImportDeclaration(_)
            | AstKind::ExportDeclaration(_)
            | AstKind::ExportNamedDeclaration(_)
            | AstKind::ExportFromDeclaration(_)
            | AstKind::ExportDefaultDeclaration(_)
            | AstKind::ExportAllDeclaration(_)
            | AstKind::ImportMeta(_)
                if self.commonjs =>
            {
                self.supported = false;
            }
            AstKind::AwaitExpression(_) if self.commonjs && self.function_depth == 0 => {
                self.supported = false;
            }
            AstKind::ForOfStatement(statement)
                if self.commonjs && self.function_depth == 0 && statement.r#await =>
            {
                self.supported = false;
            }
            // Oxc's namespace mutation and enum lowering do not yet have proven
            // tsx parity. Import-equals aliases can change import side effects,
            // and export assignments have different evaluation order.
            AstKind::TSNamespaceDeclaration(_)
            | AstKind::TSExternalModuleDeclaration(_)
            | AstKind::TSGlobalDeclaration(_)
            | AstKind::TSEnumDeclaration(_)
            | AstKind::TSImportEqualsDeclaration(_)
            | AstKind::TSExportAssignment(_)
            | AstKind::TSNamespaceExportDeclaration(_)
            // Keep both decorator proposals and JSX on the existing backend.
            | AstKind::Decorator(_)
            | AstKind::JSXElement(_)
            | AstKind::JSXFragment(_)
            | AstKind::AccessorProperty(_)
            // Import attributes/assertions have Node-version-specific lowering.
            | AstKind::WithClause(_) => self.supported = false,
            AstKind::ImportDeclaration(import)
                if import.phase.is_some()
                    || (self.typescript
                        && !self.only_remove_type_imports
                        && import.specifiers.as_ref().is_some_and(|specifiers| specifiers.is_empty())) =>
            {
                // In TypeScript's inferred-elision mode, esbuild removes an
                // explicit empty import. Oxc retains its module side effects.
                // A bare import has no specifier list and must remain eligible.
                self.supported = false;
            }
            AstKind::ImportExpression(import) if import.phase.is_some() || import.options.is_some() => {
                self.supported = false;
            }
            AstKind::ExportFromDeclaration(export)
                if self.typescript
                    && (export.export_kind.is_type()
                        || export.specifiers.iter().all(|specifier| specifier.export_kind.is_type())) =>
            {
                // Empty and type-only re-exports have different module-side-
                // effect retention between the compilers, depending on the
                // import-elision option. Keep all variants on one backend.
                self.supported = false;
            }
            AstKind::FormalParameter(parameter)
                if parameter.accessibility.is_some()
                    || parameter.readonly
                    || parameter.r#override =>
            {
                self.supported = false;
            }
            AstKind::PropertyDefinition(property)
                if !self.use_define_for_class_fields && !property.declare =>
            {
                self.supported = false;
            }
            _ => {}
        }
    }

    fn leave_node(&mut self, kind: AstKind<'a>) {
        if matches!(
            kind,
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)
        ) {
            self.function_depth -= 1;
        }
    }
}

fn transform_source(filename: &str, source: &str, options: &Options) -> Option<TransformOutput> {
    // Module conversion stays on the compatibility backend. Sources already
    // written as CommonJS can use Oxc without changing their module semantics.
    let commonjs = match options.source_type.as_str() {
        "module" => false,
        "commonjs" => true,
        _ => return None,
    };
    if !options.source_map {
        return None;
    }
    let source_type = match options.lang.as_str() {
        "ts" => SourceType::ts(),
        "tsx" => SourceType::tsx(),
        "js" => SourceType::mjs(),
        "jsx" => SourceType::jsx(),
        _ => return None,
    }
    .with_module(true)
    .with_commonjs(commonjs);
    let _ = &options.jsx;
    let mut transform_options = TransformOptions::from_target(&options.target).ok()?;
    transform_options.typescript.only_remove_type_imports = options.only_remove_type_imports;
    transform_options
        .typescript
        .remove_class_fields_without_initializer = !options.use_define_for_class_fields;

    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return None;
    }
    let mut program = parsed.program;
    // The compatibility compiler owns input source-map composition. Inspect
    // actual comment spans so an example string does not affect eligibility.
    if program.comments.iter().any(|comment| {
        let text = comment.content_span().source_text(source);
        text.contains("sourceMappingURL") || text.contains("sourceURL")
    }) {
        return None;
    }
    // A hashbang must precede the wrapper banner. Let the compatibility backend
    // handle this uncommon case until codegen has a dedicated preamble API.
    if commonjs && program.hashbang.is_some() {
        return None;
    }
    let mut eligibility = Eligibility {
        supported: true,
        use_define_for_class_fields: options.use_define_for_class_fields,
        commonjs,
        function_depth: 0,
        typescript: source_type.is_typescript(),
        only_remove_type_imports: options.only_remove_type_imports,
    };
    eligibility.visit_program(&program);
    if !eligibility.supported {
        return None;
    }

    let semantic = SemanticBuilder::new_compiler()
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        return None;
    }
    let transformed = Transformer::new(&allocator, Path::new(filename), &transform_options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    // Diagnostics and external helpers cause whole-source fallback, never output
    // patching. This also preserves otherwise self-contained serialized functions.
    #[allow(deprecated)]
    if !transformed.diagnostics.is_empty() || !transformed.helpers_used.is_empty() {
        return None;
    }
    let mut codegen = Codegen::new().with_options(CodegenOptions {
        minify: true,
        source_map_path: Some(Path::new(filename).to_path_buf()),
        ..Default::default()
    });
    // The prefix is already in codegen's buffer when source-map positions are
    // recorded. This preserves columns and lines without editing map output.
    if let Some(banner) = &options.banner {
        codegen.print_str(banner);
        codegen.print_str("\n");
    }
    let mut generated = codegen.build(&program);
    if let Some(footer) = &options.footer {
        generated.code.push('\n');
        generated.code.push_str(footer);
    }
    Some(TransformOutput {
        code: generated.code,
        map: generated.map?.to_json_string(),
    })
}

/// Null means that the host must compile the unchanged original source with its
/// compatibility backend. Invalid source receives that backend's normal diagnostic.
#[napi]
pub fn transform_sync(
    filename: String,
    source: String,
    options_json: String,
) -> Option<TransformOutput> {
    let options = serde_json::from_str::<Options>(&options_json).ok()?;
    transform_source(&filename, &source, &options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Options {
        Options {
            target: "node24.15.0".into(),
            lang: "ts".into(),
            source_type: "module".into(),
            source_map: true,
            only_remove_type_imports: false,
            use_define_for_class_fields: true,
            jsx: None,
            banner: None,
            footer: None,
        }
    }

    #[test]
    fn transforms_typed_esm_and_keeps_source_identity() {
        let output = transform_source(
            "file.ts?namespace=one",
            "import { value } from './dep.ts'; export const answer: number = value + 1;",
            &options(),
        )
        .expect("ordinary ESM TypeScript is eligible");
        assert!(output.code.contains("from\"./dep.ts\""));
        assert!(!output.code.contains(":number"));
        let map: serde_json::Value = serde_json::from_str(&output.map).unwrap();
        assert_eq!(map["sources"][0], "file.ts?namespace=one");
    }

    #[test]
    fn distinguishes_runtime_and_type_only_imports() {
        let source =
            "import { value } from './dep.ts'; type T = typeof value; export const answer = 42;";
        let inferred = transform_source("file.ts", source, &options()).unwrap();
        assert!(!inferred.code.contains("./dep.ts"));
        let explicit = Options {
            only_remove_type_imports: true,
            ..options()
        };
        let verbatim = transform_source("file.ts", source, &explicit).unwrap();
        assert!(verbatim.code.contains("./dep.ts"));
    }

    #[test]
    fn empty_typescript_imports_fall_back_without_affecting_explicit_side_effects() {
        let source =
            "import {} from './side-effect.mjs'; export const result = globalThis.loaded ?? 0;";
        assert!(transform_source("file.ts", source, &options()).is_none());

        let verbatim = Options {
            only_remove_type_imports: true,
            ..options()
        };
        let output = transform_source("file.ts", source, &verbatim).unwrap();
        assert!(output.code.contains("./side-effect.mjs"));

        let javascript = Options {
            lang: "js".into(),
            ..options()
        };
        let output = transform_source("file.js", source, &javascript).unwrap();
        assert!(output.code.contains("./side-effect.mjs"));

        let bare = "import './side-effect.mjs'; export const result = globalThis.loaded ?? 0;";
        let output = transform_source("file.ts", bare, &options()).unwrap();
        assert!(output.code.contains("./side-effect.mjs"));
    }

    #[test]
    fn empty_and_type_only_typescript_reexports_fall_back() {
        for only_remove_type_imports in [false, true] {
            let options = Options {
                only_remove_type_imports,
                ..options()
            };
            for source in [
                "export {} from './side-effect.mjs';",
                "export { type value } from './side-effect.mjs';",
                "export type { value } from './side-effect.mjs';",
            ] {
                assert!(
                    transform_source("file.ts", source, &options).is_none(),
                    "{source}"
                );
            }
            let value_reexport = "export { value, type Item } from './side-effect.mjs';";
            let output = transform_source("file.ts", value_reexport, &options).unwrap();
            assert!(output.code.contains("value"));
            assert!(output.code.contains("./side-effect.mjs"));
            assert!(!output.code.contains("Item"));
        }
        let javascript = Options {
            lang: "js".into(),
            ..options()
        };
        let output = transform_source(
            "file.js",
            "export {} from './side-effect.mjs';",
            &javascript,
        )
        .unwrap();
        assert!(output.code.contains("./side-effect.mjs"));
    }

    #[test]
    fn checks_original_ast_before_erasing_incompatible_typescript() {
        for source in [
            "namespace State { export let value = 1; }",
            "enum State { Ready = 1 }",
            "import { Item } from './dep.ts'; import Alias = Item.Member;",
            "const value = {}; export = value;",
            "export as namespace Example;",
            "function decorate(value: any) { return value; } @decorate class Example {}",
            "class Example { constructor(public value: number) {} }",
            "class Example { accessor value = 1; }",
        ] {
            assert!(
                transform_source("file.ts", source, &options()).is_none(),
                "{source}"
            );
        }
    }

    #[test]
    fn source_text_in_strings_and_comments_does_not_disable_transform() {
        let source = "// namespace State { export let value = 1 }\nexport const text: string = 'export = value; @decorate enum State {}';";
        assert!(transform_source("file.ts", source, &options()).is_some());
    }

    #[test]
    fn public_field_set_semantics_fall_back() {
        let source = "export class Example { value: number = 1; }";
        assert!(transform_source("file.ts", source, &options()).is_some());
        let set_fields = Options {
            use_define_for_class_fields: false,
            ..options()
        };
        assert!(transform_source("file.ts", source, &set_fields).is_none());
    }

    #[test]
    fn invalid_sources_and_external_helpers_fall_back() {
        assert!(transform_source("file.ts", "export const value: = ;", &options()).is_none());
        assert!(transform_source("file.ts", "const x = 1; const x = 2;", &options()).is_none());
        let old_target = Options {
            target: "node18.0.0".into(),
            ..options()
        };
        assert!(
            transform_source(
                "file.ts",
                "using resource = { [Symbol.dispose]() {} };",
                &old_target
            )
            .is_none()
        );
    }

    #[test]
    fn input_source_maps_take_the_composing_backend() {
        assert!(transform_source(
            "file.ts",
            "export const value: number = 42;\n//# sourceMappingURL=data:application/json;base64,e30=",
            &options(),
        )
        .is_none());
        assert!(
            transform_source(
                "file.ts",
                "export const example: string = '//# sourceMappingURL=example.map';",
                &options(),
            )
            .is_some()
        );
    }

    #[test]
    fn commonjs_preserves_script_semantics_and_top_level_return() {
        let options = Options {
            source_type: "commonjs".into(),
            banner: Some("__filename=\"file.ts\";(()=>{".into()),
            footer: Some("})()".into()),
            ..options()
        };
        let source = "const value: number = require('./dep').value; module.exports = { value, sloppy: (function () { return this !== undefined; })() }; return;";
        let output = transform_source("file.ts", source, &options).unwrap();
        assert!(!output.code.contains("use strict"));
        assert!(output.code.contains("return;"));
        assert!(output.code.contains("require(\"./dep\")"));
        let map: serde_json::Value = serde_json::from_str(&output.map).unwrap();
        assert!(map["mappings"].as_str().unwrap().starts_with(';'));
        for source in [
            "export const value = 1;",
            "import value from './dep'; console.log(value);",
            "console.log(import.meta.url);",
            "await Promise.resolve();",
            "#!/usr/bin/env node\nmodule.exports = 1;",
        ] {
            assert!(
                transform_source("file.ts", source, &options).is_none(),
                "{source}"
            );
        }
        assert!(
            transform_source(
                "file.ts",
                "module.exports = async function () { await Promise.resolve(); };",
                &options,
            )
            .is_some()
        );
    }
}

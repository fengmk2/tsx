fn main() {
    println!("cargo:rerun-if-env-changed=RUSTC");
    napi_build::setup();
}

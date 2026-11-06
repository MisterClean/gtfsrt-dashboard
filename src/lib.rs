//! Bounded archive planning and analytical contracts, shared by native tests and the WASM UI.

pub mod export;
pub mod model;
pub mod planner;
pub mod queries;

#[cfg(target_arch = "wasm32")]
mod app;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(app::App);
}

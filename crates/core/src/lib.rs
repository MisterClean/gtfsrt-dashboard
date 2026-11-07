//! Transit performance analytics that run in the visitor's browser.
//!
//! The crate is plain Rust with no browser dependencies, so everything is tested
//! natively. `transit-wasm` wraps it for the Web Worker.
pub mod cube;
pub mod day;
pub mod geo;
pub mod gps;
pub mod library;
pub mod mode;
pub mod plan;
pub mod report;
pub mod rt;
pub mod schedule;
pub mod sql;
pub mod time;
pub mod trace;

//! Transit modes from GTFS route types.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Mode {
    #[default]
    All,
    Bus,
    Rail,
    Ferry,
    Other,
    Unknown,
}

impl Mode {
    /// Basic and extended GTFS route types. A missing type stays unknown rather
    /// than being guessed.
    pub fn from_route_type(route_type: Option<i32>) -> Self {
        match route_type {
            Some(3 | 11 | 200..=299 | 700..=799 | 800) => Self::Bus,
            Some(0..=2 | 5 | 7 | 12 | 100..=199 | 300..=499 | 900..=999 | 1400) => Self::Rail,
            Some(4 | 1000..=1099 | 1200) => Self::Ferry,
            Some(_) => Self::Other,
            None => Self::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_basic_and_extended_route_types() {
        assert_eq!(Mode::from_route_type(Some(3)), Mode::Bus);
        assert_eq!(Mode::from_route_type(Some(700)), Mode::Bus);
        assert_eq!(Mode::from_route_type(Some(2)), Mode::Rail);
        assert_eq!(Mode::from_route_type(Some(4)), Mode::Ferry);
        assert_eq!(Mode::from_route_type(Some(6)), Mode::Other);
        assert_eq!(Mode::from_route_type(None), Mode::Unknown);
    }
}

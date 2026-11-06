/// Quote a source value for CSV while preventing spreadsheet formula execution.
pub fn csv_cell(value: &str) -> String {
    let trimmed = value.trim_start_matches([' ', '\t', '\r', '\n']);
    let needs_prefix =
        trimmed.starts_with(['=', '+', '-', '@']) || value.starts_with(['\t', '\r', '\n']);
    let safe = if needs_prefix {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_punctuation_and_neutralizes_producer_formulas() {
        assert_eq!(csv_cell("A, \"Express\""), "\"A, \"\"Express\"\"\"");
        for value in ["=1+1", "  =1+1", "@SUM(A1)", "\n=1+1", "\t+1"] {
            assert!(csv_cell(value).starts_with("\"'"), "{value:?}");
        }
        assert_eq!(csv_cell("14-West"), "\"14-West\"");
    }
}

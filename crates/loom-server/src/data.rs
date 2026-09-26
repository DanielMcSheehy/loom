//! SQL over ingested datasets, powered by Polars — a Rust dataframe engine.
//!
//! Every dataset (NDJSON on disk) is registered as a SQL table under its own
//! name and a `-`→`_` alias, so `SELECT sensor, avg(value) FROM sensor_readings
//! GROUP BY sensor` works across datasets, including joins. Scans are lazy:
//! Polars pushes projections and predicates down to the file scan, so queries
//! only materialize what they select.

use std::path::Path;

use polars::prelude::*;
use polars::sql::SQLContext;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct QueryOutcome {
    /// JSON array of row objects, already serialized by Polars.
    pub rows_json: Vec<u8>,
    pub row_count: usize,
    pub truncated: bool,
}

/// Execute one SQL query against the registered datasets. Blocking —
/// call via `spawn_blocking`.
pub fn run_query(
    datasets_dir: &Path,
    datasets: &[String],
    sql: &str,
    limit: usize,
) -> Result<QueryOutcome, String> {
    let mut ctx = SQLContext::new();
    for name in datasets {
        let path = datasets_dir.join(format!("{name}.ndjson"));
        if !path.exists() {
            continue;
        }
        let lf = LazyJsonLineReader::new(PlPath::new(&path.to_string_lossy()))
            .with_infer_schema_length(Some(1000.try_into().expect("nonzero")))
            .finish()
            .map_err(|e| format!("failed to scan dataset `{name}`: {e}"))?;
        ctx.register(name, lf.clone());
        let alias = name.replace('-', "_");
        if alias != *name {
            ctx.register(&alias, lf);
        }
    }

    let lazy = ctx.execute(sql).map_err(|e| format!("query failed: {e}"))?;
    // Fetch one row beyond the cap so truncation is detectable.
    let mut df = lazy
        .limit((limit + 1) as IdxSize)
        .collect()
        .map_err(|e| format!("query failed: {e}"))?;
    let truncated = df.height() > limit;
    if truncated {
        df = df.head(Some(limit));
    }

    let mut rows_json = Vec::new();
    JsonWriter::new(&mut rows_json)
        .with_json_format(JsonFormat::Json)
        .finish(&mut df)
        .map_err(|e| format!("failed to serialize result: {e}"))?;
    Ok(QueryOutcome {
        rows_json,
        row_count: df.height(),
        truncated,
    })
}

/// Per-column summary statistics for a dataset.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnProfile {
    pub name: String,
    /// Simplified type: integer | float | string | boolean | datetime | list |
    /// struct | null | other.
    pub dtype: &'static str,
    pub null_count: usize,
    /// Numbers for numeric columns, strings for string/datetime columns,
    /// `null` when not applicable.
    pub min: Value,
    pub max: Value,
    /// Numeric columns only.
    pub mean: Option<f64>,
    /// Exact distinct count (null when the type doesn't support it).
    pub distinct: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatasetProfile {
    pub columns: Vec<ColumnProfile>,
    /// First `sample_size` rows as JSON objects.
    pub sample: Vec<Value>,
    pub sample_size: usize,
}

/// Profile one NDJSON dataset: per-column stats plus the first `sample`
/// rows. Blocking — call via `spawn_blocking`.
pub fn describe_dataset(path: &Path, sample: usize) -> Result<DatasetProfile, String> {
    if !path.is_file() {
        return Err(format!("dataset file not found: {}", path.display()));
    }
    let df = LazyJsonLineReader::new(PlPath::new(&path.to_string_lossy()))
        .with_infer_schema_length(Some(1000.try_into().expect("nonzero")))
        .finish()
        .and_then(|lf| lf.collect())
        .map_err(|e| format!("failed to scan dataset: {e}"))?;

    let mut columns = Vec::with_capacity(df.width());
    for col in df.get_columns() {
        let series = col.as_materialized_series();
        let dtype = simplify_dtype(series.dtype());
        let numeric = series.dtype().is_primitive_numeric();
        let comparable = numeric || matches!(dtype, "string" | "datetime" | "boolean");
        let (min, max) = if comparable {
            (
                series
                    .min_reduce()
                    .map(|s| any_value_to_json(s.value()))
                    .unwrap_or(Value::Null),
                series
                    .max_reduce()
                    .map(|s| any_value_to_json(s.value()))
                    .unwrap_or(Value::Null),
            )
        } else {
            (Value::Null, Value::Null)
        };
        let mean = if numeric {
            series
                .mean_reduce()
                .value()
                .extract::<f64>()
                .filter(|m| m.is_finite())
        } else {
            None
        };
        let distinct = if matches!(dtype, "list" | "struct" | "other") {
            None
        } else {
            series.n_unique().ok()
        };
        columns.push(ColumnProfile {
            name: series.name().to_string(),
            dtype,
            null_count: series.null_count(),
            min,
            max,
            mean,
            distinct,
        });
    }

    let mut head = df.head(Some(sample));
    let mut buf = Vec::new();
    JsonWriter::new(&mut buf)
        .with_json_format(JsonFormat::Json)
        .finish(&mut head)
        .map_err(|e| format!("failed to serialize sample: {e}"))?;
    let sample_rows: Vec<Value> =
        serde_json::from_slice(&buf).map_err(|e| format!("bad sample encoding: {e}"))?;
    Ok(DatasetProfile {
        columns,
        sample_size: sample_rows.len(),
        sample: sample_rows,
    })
}

fn simplify_dtype(dt: &DataType) -> &'static str {
    if dt.is_integer() {
        "integer"
    } else if dt.is_float() {
        "float"
    } else if dt.is_string() {
        "string"
    } else if dt.is_bool() {
        "boolean"
    } else if dt.is_temporal() {
        "datetime"
    } else if dt.is_list() {
        "list"
    } else if dt.is_struct() {
        "struct"
    } else if dt.is_null() {
        "null"
    } else {
        "other"
    }
}

fn any_value_to_json(av: &AnyValue) -> Value {
    match av {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(b) => Value::Bool(*b),
        AnyValue::String(s) => Value::String((*s).to_string()),
        AnyValue::StringOwned(s) => Value::String(s.to_string()),
        v if v.is_integer() => v
            .extract::<i64>()
            .map(Value::from)
            .unwrap_or_else(|| Value::String(v.to_string())),
        v if v.is_float() => v
            .extract::<f64>()
            .filter(|f| f.is_finite())
            .map(Value::from)
            .unwrap_or(Value::Null),
        // Temporal and everything else: Polars' display form (ISO-ish).
        v => Value::String(v.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_dataset(dir: &Path, name: &str, lines: &[&str]) {
        std::fs::write(dir.join(format!("{name}.ndjson")), lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn aggregates_with_sql() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(
            dir.path(),
            "readings",
            &[
                r#"{"sensor":"a","value":10.0}"#,
                r#"{"sensor":"a","value":20.0}"#,
                r#"{"sensor":"b","value":5.0}"#,
            ],
        );
        let out = run_query(
            dir.path(),
            &["readings".into()],
            "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n \
             FROM readings GROUP BY sensor ORDER BY sensor",
            100,
        )
        .unwrap();
        let rows: serde_json::Value = serde_json::from_slice(&out.rows_json).unwrap();
        assert_eq!(out.row_count, 2);
        assert!(!out.truncated);
        assert_eq!(rows[0]["sensor"], "a");
        assert_eq!(rows[0]["avg_value"], 15.0);
        assert_eq!(rows[1]["n"], 1);
    }

    #[test]
    fn dashed_names_get_underscore_alias() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(dir.path(), "sensor-readings", &[r#"{"v":1}"#, r#"{"v":2}"#]);
        let out = run_query(
            dir.path(),
            &["sensor-readings".into()],
            "SELECT SUM(v) AS total FROM sensor_readings",
            100,
        )
        .unwrap();
        let rows: serde_json::Value = serde_json::from_slice(&out.rows_json).unwrap();
        assert_eq!(rows[0]["total"], 3);
    }

    #[test]
    fn truncates_at_limit() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(
            dir.path(),
            "big",
            &[r#"{"v":1}"#, r#"{"v":2}"#, r#"{"v":3}"#],
        );
        let out = run_query(dir.path(), &["big".into()], "SELECT * FROM big", 2).unwrap();
        assert_eq!(out.row_count, 2);
        assert!(out.truncated);
    }

    #[test]
    fn bad_sql_is_a_client_error() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(dir.path(), "d", &[r#"{"v":1}"#]);
        let err = run_query(dir.path(), &["d".into()], "SELEKT nope", 10).unwrap_err();
        assert!(err.contains("query failed"));
    }

    #[test]
    fn describe_profiles_numeric_columns() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(
            dir.path(),
            "nums",
            &[
                r#"{"v":1,"f":1.5}"#,
                r#"{"v":3,"f":2.5}"#,
                r#"{"v":2,"f":null}"#,
            ],
        );
        let p = describe_dataset(&dir.path().join("nums.ndjson"), 20).unwrap();
        let v = p.columns.iter().find(|c| c.name == "v").unwrap();
        assert_eq!(v.dtype, "integer");
        assert_eq!(v.min, serde_json::json!(1));
        assert_eq!(v.max, serde_json::json!(3));
        assert_eq!(v.mean, Some(2.0));
        assert_eq!(v.distinct, Some(3));
        assert_eq!(v.null_count, 0);
        let f = p.columns.iter().find(|c| c.name == "f").unwrap();
        assert_eq!(f.dtype, "float");
        assert_eq!(f.null_count, 1);
        assert_eq!(f.mean, Some(2.0));
        assert_eq!(f.min, serde_json::json!(1.5));
    }

    #[test]
    fn describe_profiles_string_and_bool_columns() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(
            dir.path(),
            "strs",
            &[
                r#"{"s":"pear","ok":true}"#,
                r#"{"s":"apple","ok":false}"#,
                r#"{"s":"apple","ok":true}"#,
                r#"{"s":null,"ok":true}"#,
            ],
        );
        let p = describe_dataset(&dir.path().join("strs.ndjson"), 20).unwrap();
        let s = p.columns.iter().find(|c| c.name == "s").unwrap();
        assert_eq!(s.dtype, "string");
        assert_eq!(s.min, serde_json::json!("apple"));
        assert_eq!(s.max, serde_json::json!("pear"));
        assert_eq!(s.mean, None);
        assert_eq!(s.null_count, 1);
        assert_eq!(s.distinct, Some(3), "null counts as a distinct value");
        let ok = p.columns.iter().find(|c| c.name == "ok").unwrap();
        assert_eq!(ok.dtype, "boolean");
        assert_eq!(ok.min, serde_json::json!(false));
        assert_eq!(ok.max, serde_json::json!(true));
        assert_eq!(ok.mean, None);
    }

    #[test]
    fn describe_sample_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        write_dataset(
            dir.path(),
            "big",
            &[r#"{"v":1}"#, r#"{"v":2}"#, r#"{"v":3}"#, r#"{"v":4}"#],
        );
        let p = describe_dataset(&dir.path().join("big.ndjson"), 2).unwrap();
        assert_eq!(p.sample_size, 2);
        assert_eq!(p.sample.len(), 2);
        assert_eq!(p.sample[0]["v"], 1);
        assert_eq!(p.sample[1]["v"], 2);
        let all = describe_dataset(&dir.path().join("big.ndjson"), 50).unwrap();
        assert_eq!(all.sample_size, 4);
    }

    #[test]
    fn describe_missing_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = describe_dataset(&dir.path().join("nope.ndjson"), 20).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }
}

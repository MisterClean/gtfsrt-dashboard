use crate::export::csv_cell;
use crate::model::*;
use crate::planner::{choose_schedule, enforce_byte_budget, plan_selection, valid_key};
use crate::queries::{self, METRIC_VERSION};
use leptos::prelude::*;
use serde::Deserialize;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

#[wasm_bindgen(module = "/web/bridge.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = loadCatalog)]
    async fn load_catalog() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = prepareArchive)]
    async fn prepare_archive(
        selection: JsValue,
        progress: &js_sys::Function,
    ) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = loadRoutes)]
    async fn load_routes(choice: JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = runQueries)]
    async fn run_queries(
        normalize: &str,
        queries: JsValue,
        progress: &js_sys::Function,
    ) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = cancelArchive)]
    fn cancel_archive();
    #[wasm_bindgen(js_name = initialSelection)]
    fn initial_selection() -> JsValue;
    #[wasm_bindgen(js_name = rememberSelection)]
    fn remember_selection(selection: JsValue);
    #[wasm_bindgen(js_name = downloadFile)]
    fn download_file(name: &str, content: &str, mime: &str);
    #[wasm_bindgen(catch, js_name = copyLink)]
    async fn copy_link() -> Result<(), JsValue>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Overview,
    Routes,
    Positions,
    Sources,
}

#[derive(Clone, Copy)]
struct Ui {
    feeds: RwSignal<Vec<Feed>>,
    feed: RwSignal<String>,
    from: RwSignal<String>,
    to: RwSignal<String>,
    view: RwSignal<View>,
    busy: RwSignal<bool>,
    catalog_busy: RwSignal<bool>,
    phase: RwSignal<String>,
    error: RwSignal<Option<String>>,
    report: RwSignal<Option<Arc<Report>>>,
    generation: RwSignal<u64>,
    toast: RwSignal<String>,
}

fn js_error(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            value
                .dyn_ref::<js_sys::Error>()
                .map(|e| String::from(e.message()))
        })
        .unwrap_or_else(|| {
            "An unexpected browser error occurred. Reload the archive to try again.".into()
        })
}

fn encode(value: &impl serde::Serialize) -> Result<JsValue, String> {
    serde_wasm_bindgen::to_value(value).map_err(|e| e.to_string())
}

fn decode<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, String> {
    serde_wasm_bindgen::from_value(value)
        .map_err(|e| format!("The archive returned unexpected data: {e}"))
}

impl Ui {
    fn selected_feed(self) -> Option<Feed> {
        self.feeds
            .get()
            .into_iter()
            .find(|f| f.base64url == self.feed.get())
    }

    fn clear(self) {
        self.generation.update(|v| *v += 1);
        cancel_archive();
        self.report.set(None);
        self.error.set(None);
        self.busy.set(false);
        self.phase.set(String::new());
        self.toast.set(String::new());
    }

    fn catalog(self) {
        self.catalog_busy.set(true);
        self.error.set(None);
        spawn_local(async move {
            let result = async {
                let mut feeds: Vec<Feed> = decode(load_catalog().await.map_err(js_error)?)?;
                feeds.retain(|f| {
                    f.feed_type == "vehicle_positions"
                        && valid_key(&f.base64url)
                        && plan_selection(f, &f.date_max, &f.date_max).is_ok()
                });
                feeds.sort_by_key(Feed::label);
                if feeds.is_empty() {
                    return Err(
                        "The catalog lists no supported vehicle-position feeds. Retry later."
                            .to_owned(),
                    );
                }
                #[derive(Deserialize)]
                struct Initial {
                    feed: Option<String>,
                    from: Option<String>,
                    to: Option<String>,
                }
                let initial: Initial = decode(initial_selection())?;
                let default = feeds
                    .iter()
                    .find(|f| Some(&f.base64url) == initial.feed.as_ref())
                    .or_else(|| {
                        feeds
                            .iter()
                            .find(|f| f.agency_id.as_deref() == Some("metro-transit-madison"))
                    })
                    .unwrap_or(&feeds[0]);
                self.feed.set(default.base64url.clone());
                self.from
                    .set(initial.from.unwrap_or_else(|| default.date_max.clone()));
                self.to
                    .set(initial.to.unwrap_or_else(|| default.date_max.clone()));
                self.feeds.set(feeds);
                Ok::<_, String>(())
            }
            .await;
            self.catalog_busy.set(false);
            if let Err(error) = result {
                self.error.set(Some(error));
            }
        });
    }

    fn load(self) {
        if self.busy.get_untracked() {
            return;
        }
        let Some(feed) = self.selected_feed() else {
            self.error
                .set(Some("Choose a feed from the archive catalog.".into()));
            return;
        };
        let selection = match plan_selection(&feed, &self.from.get(), &self.to.get()) {
            Ok(selection) => selection,
            Err(error) => {
                self.error.set(Some(error.to_string()));
                return;
            }
        };
        self.clear();
        self.busy.set(true);
        let generation = self.generation.get_untracked();
        spawn_local(async move {
            let progress = Closure::<dyn Fn(String)>::new(move |message| {
                if self.generation.get_untracked() == generation {
                    self.phase.set(message);
                }
            });
            let callback = progress.as_ref().unchecked_ref::<js_sys::Function>();
            let result = async {
                let prepared: PreparedArchive = decode(prepare_archive(encode(&selection)?, callback).await.map_err(js_error)?)?;
                enforce_byte_budget(prepared.files.iter().map(|f| f.bytes)).map_err(|e| e.to_string())?;
                let mut warnings = prepared.warnings.clone();
                let mut schedule = choose_schedule(&prepared.metadata, &prepared.schedules, &selection);
                let route_metadata: Vec<RouteMetadata> = if let Some(choice) = &schedule {
                    match load_routes(encode(choice)?).await.map_err(js_error).and_then(decode) {
                        Ok(routes) => routes,
                        Err(error) => { warnings.push(format!("Mode filtering is unavailable: {error}")); schedule = None; Vec::new() }
                    }
                } else {
                    warnings.push("No single historical schedule version covers this selection. Route IDs are shown as reported; mode filtering is unavailable.".into());
                    Vec::new()
                };
                let normalize = queries::normalization(&prepared.columns, &prepared.files).map_err(|e| e.to_string())?;
                let sql = queries::aggregates(Mode::All, None, &route_metadata);
                let analysis: Analysis = decode(run_queries(&normalize, encode(&sql)?, callback).await.map_err(js_error)?)?;
                let available_routes = analysis.routes.clone();
                let mut all_sql = vec![("Normalize archive".into(), normalize)];
                all_sql.extend(sql);
                Ok::<_, String>(Report { selection, prepared, schedule, route_metadata, analysis, available_routes, mode: Mode::All, route: None, sql: all_sql, warnings })
            }.await;
            if self.generation.get_untracked() != generation {
                return;
            }
            self.busy.set(false);
            self.phase.set(String::new());
            match result {
                Ok(report) => {
                    if let Ok(value) = encode(&report.selection) {
                        remember_selection(value);
                    }
                    self.report.set(Some(Arc::new(report)));
                }
                Err(error) => {
                    cancel_archive();
                    self.error.set(Some(error));
                }
            }
        });
    }

    fn filter(self, mode: Mode, route: Option<String>) {
        if self.busy.get_untracked() {
            return;
        }
        let Some(report) = self.report.get_untracked() else {
            return;
        };
        self.busy.set(true);
        self.error.set(None);
        let generation = self.generation.get_untracked();
        spawn_local(async move {
            let progress = Closure::<dyn Fn(String)>::new(move |message| self.phase.set(message));
            let sql = queries::aggregates(mode, route.as_deref(), &report.route_metadata);
            let result = async {
                decode::<Analysis>(
                    run_queries("", encode(&sql)?, progress.as_ref().unchecked_ref())
                        .await
                        .map_err(js_error)?,
                )
            }
            .await;
            if self.generation.get_untracked() != generation {
                return;
            }
            self.busy.set(false);
            self.phase.set(String::new());
            match result {
                Ok(analysis) => {
                    let mut next = (*report).clone();
                    next.analysis = analysis;
                    next.mode = mode;
                    next.route = route;
                    next.sql.truncate(1);
                    next.sql.extend(sql);
                    self.report.set(Some(Arc::new(next)));
                }
                Err(error) => {
                    cancel_archive();
                    self.report.set(None);
                    self.error.set(Some(error));
                }
            }
        });
    }
}

#[component]
pub fn App() -> impl IntoView {
    let ui = Ui {
        feeds: RwSignal::new(Vec::new()),
        feed: RwSignal::new(String::new()),
        from: RwSignal::new(String::new()),
        to: RwSignal::new(String::new()),
        view: RwSignal::new(View::Overview),
        busy: RwSignal::new(false),
        catalog_busy: RwSignal::new(true),
        phase: RwSignal::new(String::new()),
        error: RwSignal::new(None),
        report: RwSignal::new(None),
        generation: RwSignal::new(0),
        toast: RwSignal::new(String::new()),
    };
    ui.catalog();
    view! {
        <a class="skip-link" href="#dashboard">"Skip to dashboard"</a>
        <header class="site-bar">
            <a class="back-link" href="https://michaelmclean.me/">"Michael McLean"<span aria-hidden="true">" / "</span><span>"Transit Notebook"</span></a>
            <span class="local-label"><span class="status-dot"></span>"Runs on your device"</span>
        </header>
        <main id="dashboard" class="workspace">
            <section class="intro" aria-labelledby="page-title">
                <div><h1 id="page-title">"Explore the transit archive."</h1><p>"A closer look at your agency’s vehicle activity. Real archive data, queried in your browser."</p></div>
                <a class="source-link" href="https://github.com/MisterClean/gtfsrt-dashboard" target="_blank" rel="noopener noreferrer">"View source"<ExternalLink/></a>
            </section>
            <section class="selection" aria-label="Archive selection">
                <div class="selection-fields">
                    <label class="agency-field">"Agency / feed"
                        <select aria-label="Agency / feed" prop:value=move || ui.feed.get() disabled=move || ui.busy.get() || ui.catalog_busy.get() on:change=move |ev| {
                            let key = event_target_value(&ev); ui.clear();
                            if let Some(feed) = ui.feeds.get_untracked().iter().find(|f| f.base64url == key) { ui.from.set(feed.date_max.clone()); ui.to.set(feed.date_max.clone()); }
                            ui.feed.set(key);
                        }>
                            <Show when=move || ui.catalog_busy.get()><option>"Loading agencies…"</option></Show>
                            {move || ui.feeds.get().into_iter().map(|feed| view! { <option value=feed.base64url.clone() selected=move || ui.feed.get() == feed.base64url>{feed.label()}</option> }).collect_view()}
                        </select>
                    </label>
                    <label>"From · UTC"<input aria-label="From date UTC" type="date" prop:value=move || ui.from.get() disabled=move || ui.busy.get() || ui.catalog_busy.get() min=move || ui.selected_feed().map(|f| f.date_min) max=move || ui.selected_feed().map(|f| f.date_max) on:change=move |ev| { let value = event_target_value(&ev); ui.clear(); if ui.to.get_untracked() < value { ui.to.set(value.clone()); } ui.from.set(value); }/></label>
                    <label>"To · UTC"<input aria-label="To date UTC" type="date" prop:value=move || ui.to.get() disabled=move || ui.busy.get() || ui.catalog_busy.get() min=move || ui.from.get() max=move || ui.selected_feed().map(|f| f.date_max) on:change=move |ev| { let value = event_target_value(&ev); ui.clear(); ui.to.set(value); }/></label>
                    <Show when=move || ui.busy.get() fallback=move || view! { <button class="primary" disabled=move || ui.catalog_busy.get() || ui.feeds.get().is_empty() on:click=move |_| ui.load()>"Load archive"<Arrow/></button> }>
                        <button class="cancel" on:click=move |_| { ui.clear(); ui.phase.set("Canceled. The local database was cleared.".into()); }>"Cancel load"</button>
                    </Show>
                </div>
                <div class="selection-meta"><span>{move || ui.selected_feed().map(|f| format!("Catalog range: {} — {}", f.date_min, f.date_max)).unwrap_or_else(|| "Fetching the public archive catalog…".into())}</span><span>"1–6 UTC days · up to 128 MiB"</span></div>
            </section>
            <Show when=move || ui.error.get().is_some()><div class="error" role="alert"><strong>"The archive could not be loaded."</strong><p>{move || ui.error.get()}</p><Show when=move || ui.feeds.get().is_empty()><button class="secondary" on:click=move |_| ui.catalog()>"Retry catalog"</button></Show></div></Show>
            <div class="query-status" role="status" aria-live="polite" hidden=move || ui.phase.get().is_empty()><span class="work-indicator" class:working=move || ui.busy.get()></span>{move || ui.phase.get()}</div>
            <nav class="view-nav" aria-label="Dashboard views">
                {[(View::Overview, "Overview"), (View::Routes, "Routes"), (View::Positions, "Positions"), (View::Sources, "Sources & SQL")].into_iter().map(|(view, label)| view! {
                    <button class:active=move || ui.view.get() == view aria-pressed=move || ui.view.get() == view on:click=move |_| ui.view.set(view)>{label}</button>
                }).collect_view()}
                <span class="archive-label">"GTFS-RT / vehicle positions"</span>
            </nav>
            <Show when=move || ui.report.get().is_some() fallback=move || view! { <EmptyState ui/> }>
                {move || ui.report.get().map(|report| view! { <ReportView ui report/> })}
            </Show>
        </main>
        <footer class="site-footer"><span>"Transit Notebook · Built by "<a href="https://michaelmclean.me/">"Michael McLean"</a></span><span>"Rust + DuckDB-WASM · "<a href="https://gtfsrt.io/" target="_blank" rel="noopener noreferrer">"Data from gtfsrt.io"<ExternalLink/></a></span></footer>
    }
}

#[component]
fn Arrow() -> impl IntoView {
    view! { <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg> }
}

#[component]
fn ExternalLink() -> impl IntoView {
    view! { <svg class="icon external-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4H4v12h12v-3M9 4h7v7M8 12l8-8"/></svg> }
}

#[component]
fn EmptyState(ui: Ui) -> impl IntoView {
    view! {
        <section class="empty-state" aria-busy=move || ui.busy.get()>
            <svg class="empty-chart" viewBox="0 0 360 110" aria-hidden="true"><path class="empty-axis" d="M0 100h360"/>{(0..24).map(|i| view! { <rect class="empty-bar" x={i * 15 + 2} y={100 - [15, 10, 6, 4, 4, 8, 30, 55, 70, 61, 52, 48, 53, 55, 62, 75, 86, 94, 75, 56, 40, 33, 28, 21][i]} width="10" height=[15, 10, 6, 4, 4, 8, 30, 55, 70, 61, 52, 48, 53, 55, 62, 75, 86, 94, 75, 56, 40, 33, 28, 21][i]/> }).collect_view()}</svg>
            <h2>{move || if ui.busy.get() { "Your browser is doing the work." } else { "Start with a day." }}</h2>
            <p>{move || if ui.busy.get() { "The archive is read directly into a temporary DuckDB database on this device. You can cancel at any time." } else { "Choose an agency and a date, then load its archive. Follow reported activity through the day, explore routes, and inspect vehicle positions." }}</p>
            <span class="empty-caption">"Illustrative activity pattern · your results appear after loading"</span>
            <div class="privacy-note"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="10" rx="1"/><path d="M6 17h8m-4-3v3"/></svg><span>"No account. No data upload. No query server."</span></div>
        </section>
    }
}

#[component]
fn ReportView(ui: Ui, report: Arc<Report>) -> impl IntoView {
    let report = StoredValue::new(report);
    let summary = report.with_value(|r| r.summary());
    let day_count = report.with_value(|r| r.selection.files.len());
    let mode = report.with_value(|r| r.mode);
    let route = report.with_value(|r| r.route.clone());
    let options = report.with_value(|r| {
        let mut modes = vec![Mode::All];
        for row in &r.available_routes {
            let mode = r.route_mode(&row.route_id);
            if !modes.contains(&mode) {
                modes.push(mode);
            }
        }
        modes
    });
    view! {
        <section class="report-heading"><div><h2>{report.with_value(|r| r.selection.feed.label())}</h2><p>{report.with_value(|r| if r.selection.from == r.selection.to { format!("{} · one UTC archive day", r.selection.from) } else { format!("{} — {} · {day_count} UTC archive days", r.selection.from, r.selection.to) })}</p></div>
            <div class="report-actions"><button class="text-button" on:click=move |_| export_routes(&report.get_value())>"Export routes"<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m-4-4 4 4 4-4M4 14v3h12v-3"/></svg></button><button class="text-button" on:click=move |_| spawn_local(async move { ui.toast.set(match copy_link().await { Ok(()) => "Selection link copied. The recipient loads their own data.".into(), Err(_) => "Copy the selection link from your browser’s address bar.".into() }); })>"Copy selection link"</button></div>
        </section>
        <div class="toast" role="status" hidden=move || ui.toast.get().is_empty()>{move || ui.toast.get()}</div>
        <div class="report-filters">
            <label>"Mode"<select aria-label="Mode" disabled=move || ui.busy.get() || report.with_value(|r| r.schedule.is_none()) on:change=move |ev| {
                let value = event_target_value(&ev); let selected = [Mode::All, Mode::Bus, Mode::Rail, Mode::Ferry, Mode::Other, Mode::Unknown].into_iter().find(|m| m.label() == value).unwrap_or(Mode::All); ui.filter(selected, None);
            }>{options.into_iter().map(|option| view! { <option selected=option == mode>{option.label()}</option> }).collect_view()}</select></label>
            <label>"Route"<select aria-label="Route" disabled=move || ui.busy.get() on:change=move |ev| { let value = event_target_value(&ev); ui.filter(mode, value.strip_prefix("route:").map(str::to_owned)); }><option value="all" selected=route.is_none()>"All routes"</option>{report.with_value(|r| r.available_routes.iter().filter(|row| mode == Mode::All || r.route_mode(&row.route_id) == mode).map(|row| {
                let id = row.route_id.clone(); let label = if id.is_empty() { "Unreported route".into() } else { format!("{} {}", id, r.route_name(&id)) }; view! { <option value=format!("route:{id}") selected=route.as_ref() == Some(&id)>{label}</option> }
            }).collect_view())}</select></label>
            <span class="filter-hint">{report.with_value(|r| if r.schedule.is_some() { "Modes from historical schedule routes. Filters run locally." } else { "Mode metadata unavailable. Route filters run locally." })}</span>
            <Show when=move || report.with_value(|r| r.route.is_some() || r.mode != Mode::All)><button class="text-button" disabled=move || ui.busy.get() on:click=move |_| ui.filter(Mode::All, None)>"Clear filters"</button></Show>
        </div>
        <Show when=move || ui.view.get() != View::Sources>
            <dl class="metrics"><div><dt>"Archived observations"</dt><dd>{number(summary.observations)}</dd><small>"Includes repeated polls"</small></div><div><dt>"Reported vehicles"</dt><dd>{number(summary.vehicles)}</dd><small>"Distinct nonempty vehicle IDs"</small></div><div><dt>"Routes observed"</dt><dd>{number(summary.routes)}</dd><small>"Distinct nonempty route IDs"</small></div><div><dt>"Hours with records"</dt><dd>{report.with_value(|r| r.analysis.coverage.len())}<span class="denominator">{format!(" / {}", day_count * 24)}</span></dd><small>"UTC hours, archive coverage"</small></div></dl>
            <p class="metric-note">"These are reported observations, not completed trips, fleet size, or service delivered."</p>
        </Show>
        <div class="view-content" aria-busy=move || ui.busy.get()>
            {move || match ui.view.get() {
                View::Overview => view! { <Overview ui report=report.get_value()/> }.into_any(),
                View::Routes => view! { <Routes ui report=report.get_value()/> }.into_any(),
                View::Positions => view! { <Positions report=report.get_value()/> }.into_any(),
                View::Sources => view! { <Sources report=report.get_value()/> }.into_any(),
            }}
        </div>
        <div class="run-receipt"><span class="status-dot"></span>{report.with_value(|r| format!("Queried on this device · {:.1} MiB of selected objects · {:.1}s calculation · DuckDB {}", r.prepared.files.iter().map(|f| f.bytes).sum::<u64>() as f64 / 1_048_576.0, r.analysis.elapsed_ms / 1000.0, r.prepared.engine_version))}<span>"Downloads can exceed object sizes."</span></div>
    }
}

fn number(value: u64) -> String {
    let digits = value.to_string();
    let mut result = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            result.push(',');
        }
        result.push(ch);
    }
    result
}

fn route_color(id: &str) -> String {
    format!(
        "route-color-{}",
        id.bytes().fold(0_usize, |a, b| a
            .wrapping_mul(31)
            .wrapping_add(usize::from(b)))
            % 7
    )
}

#[component]
fn Overview(ui: Ui, report: Arc<Report>) -> impl IntoView {
    let report = StoredValue::new(report);
    let vehicles = RwSignal::new(true);
    let max_observations = report.with_value(|r| {
        r.analysis
            .routes
            .iter()
            .map(|row| row.observations)
            .max()
            .unwrap_or(1)
            .max(1)
    });
    view! {
        <section class="hour-section"><div class="section-heading"><div><h3>"Through the day"</h3><p>"Reported activity by UTC hour. Select a bar for its exact count."</p></div><div class="segmented" aria-label="Chart measure"><button class:active=move || vehicles.get() aria-pressed=move || vehicles.get() on:click=move |_| vehicles.set(true)>"Vehicles"</button><button class:active=move || !vehicles.get() aria-pressed=move || !vehicles.get() on:click=move |_| vehicles.set(false)>"Observations"</button></div></div>
            {move || view! { <HourChart rows=report.with_value(|r| r.analysis.hours.clone()) vehicles=vehicles.get()/> }}
            <p class="caption">{move || if vehicles.get() { "Distinct vehicle IDs reported in each hour, pooled across selected dates. The same vehicle can appear in multiple hours." } else { "Archive rows in each hour, pooled across selected dates. Counts depend on polling frequency and include repeated fixes." }}</p>
        </section>
        <div class="overview-columns">
            <section><div class="section-heading"><div><h3>"Routes in the archive"</h3><p>"Most observations. Select a route to look closer."</p></div><button class="text-button" on:click=move |_| ui.view.set(View::Routes)>"All routes"<Arrow/></button></div><div class="route-bars">{report.with_value(|r| r.analysis.routes.iter().take(8).map(|row| {
                let id = row.route_id.clone(); let mode = r.mode;
                view! { <button class="route-bar-row" disabled=move || ui.busy.get() on:click=move |_| ui.filter(mode, Some(id.clone()))><span class="route-id">{if row.route_id.is_empty() { "?" } else { &row.route_id }.to_owned()}</span><span class="route-bar-name">{r.route_name(&row.route_id)}</span><svg viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-track" width="200" height="8" y="2"/><rect class="bar-fill" width={row.observations as f64 / max_observations as f64 * 200.0} height="8" y="2"/></svg><span class="bar-number">{number(row.observations)}</span></button> }
            }).collect_view())}</div></section>
            <section class="coverage-panel"><h3>"What this archive can tell you"</h3><p>"A record is a vehicle report captured by the archive. A gap is an absence of archived reports, not proof that service stopped."</p><dl class="quality-list"><div><dt>"Usable coordinates"</dt><dd>{report.with_value(|r| percent(r.summary().valid_positions, r.summary().observations))}</dd></div><div><dt>"Repeated fixes retained"</dt><dd>{report.with_value(|r| number(r.summary().repeated_fixes))}</dd></div><div><dt>"Missing route ID"</dt><dd>{report.with_value(|r| number(r.summary().missing_route))}</dd></div><div><dt>"Missing vehicle ID"</dt><dd>{report.with_value(|r| number(r.summary().missing_vehicle))}</dd></div><div><dt>"Missing vehicle timestamp"</dt><dd>{report.with_value(|r| number(r.summary().missing_timestamp))}</dd></div><div><dt>"Missing daily objects"</dt><dd>{report.with_value(|r| r.prepared.files.iter().filter(|f| f.status != "available").count())}</dd></div></dl><button class="text-button" on:click=move |_| ui.view.set(View::Sources)>"Inspect data & method"<Arrow/></button></section>
        </div>
        <Coverage report=report.get_value()/>
    }
}

fn percent(numerator: u64, denominator: u64) -> String {
    if denominator == 0 {
        "Unavailable".into()
    } else {
        format!("{:.1}%", numerator as f64 * 100.0 / denominator as f64)
    }
}

#[component]
fn HourChart(rows: Vec<HourRow>, vehicles: bool) -> impl IntoView {
    let selected = RwSignal::new(None::<String>);
    let max = rows
        .iter()
        .map(|r| if vehicles { r.vehicles } else { r.observations })
        .max()
        .unwrap_or(1)
        .max(1);
    let measure = if vehicles {
        "reported vehicles"
    } else {
        "observations"
    };
    view! {
        <p class="chart-scroll-hint">"Scroll horizontally to see all UTC hours, or open the hourly table."</p><figure class="hour-chart" tabindex="0" role="region" aria-label="Scrollable hourly activity chart"><svg viewBox="0 0 1120 240" role="img" aria-label=format!("{measure} by UTC hour. A table of exact hourly values follows this chart.")>
            {[0.0, 0.5, 1.0].into_iter().map(|fraction| view! { <g><line class="grid-line" x1="46" x2="1105" y1={200.0 - fraction * 175.0} y2={200.0 - fraction * 175.0}/><text class="axis-label" x="36" y={204.0 - fraction * 175.0} text-anchor="end">{compact((fraction * max as f64).round() as u64)}</text></g> }).collect_view()}
            {(0..24).map(|hour| {
                let value = rows.iter().find(|r| r.hour == hour).map_or(0, |r| if vehicles { r.vehicles } else { r.observations });
                let height = value as f64 / max as f64 * 175.0;
                let label = format!("{hour:02}:00 UTC · {} {measure}", number(value));
                let click = label.clone(); let focus = label.clone();
                view! { <g class="hour-bar" role="button" tabindex="0" aria-label=label.clone() on:click=move |_| selected.set(Some(click.clone())) on:focus=move |_| selected.set(Some(focus.clone()))><title>{label.clone()}</title><rect class="bar-hit" x={50 + hour * 44} y="20" width="38" height="181"/><rect class="bar-fill" x={54 + hour * 44} y={200.0 - height} width="28" height=height rx="2"/><text class="axis-label" x={68 + hour * 44} y="224" text-anchor="middle">{format!("{hour:02}")}</text></g> }
            }).collect_view()}
        </svg><figcaption class="chart-selection" role="status">{move || selected.get().unwrap_or_else(|| format!("{measure} · 00:00–23:59 UTC"))}</figcaption></figure>
        <details class="chart-data"><summary>"Hourly values as a table"</summary><div class="table-scroll" tabindex="0" role="region" aria-label="Hourly activity values"><table><thead><tr><th>"UTC hour"</th><th>"Reported vehicles"</th><th>"Observations"</th></tr></thead><tbody>{(0..24).map(|hour| {
            let row = rows.iter().find(|r| r.hour == hour); view! { <tr><td>{format!("{hour:02}:00")}</td><td>{number(row.map_or(0, |r| r.vehicles))}</td><td>{number(row.map_or(0, |r| r.observations))}</td></tr> }
        }).collect_view()}</tbody></table></div></details>
    }
}

fn compact(value: u64) -> String {
    if value >= 1000 {
        format!("{:.0}k", value as f64 / 1000.0)
    } else {
        value.to_string()
    }
}

#[component]
fn Coverage(report: Arc<Report>) -> impl IntoView {
    let coverage_count = report.analysis.coverage.len();
    view! {
        <section class="coverage-section"><div class="section-heading"><div><h3>"Archive coverage"</h3><p>"Each cell is one UTC hour. Filled cells contain at least one report."</p></div><span class="coverage-legend"><span class="coverage-present"></span>"Records present"<span class="coverage-absent"></span>"No records"</span></div>
            <div class="coverage-scroll"><div class="coverage-hour-labels"><span></span>{(0..24).map(|h| view! { <span>{format!("{h:02}")}</span> }).collect_view()}</div>{report.selection.files.iter().map(|file| view! {
                <div class="coverage-day"><span class="coverage-date">{file.date.clone()}</span>{(0..24).map(|hour| {
                    let key = format!("{}T{hour:02}:00:00Z", file.date); let row = report.analysis.coverage.iter().find(|r| r.hour == key);
                    let label = row.map_or_else(|| format!("{key}: no archived records"), |r| format!("{key}: {} observations in {} captured fetches", number(r.observations), number(r.fetches)));
                    view! { <span class="coverage-cell" class:present=row.is_some() tabindex="0" title=label.clone() aria-label=label></span> }
                }).collect_view()}</div>
            }).collect_view()}</div><p class="caption">{format!("{coverage_count} of {} hours have records for the current filters. One record does not establish a complete hour. UTC days do not necessarily align with local or GTFS service days.", report.selection.files.len() * 24)}</p>
        </section>
    }
}

#[component]
fn Routes(ui: Ui, report: Arc<Report>) -> impl IntoView {
    let report = StoredValue::new(report);
    let search = RwSignal::new(String::new());
    let sort = RwSignal::new("observations");
    let ascending = RwSignal::new(false);
    let limit = RwSignal::new(20_usize);
    let filtered = move || {
        let needle = search.get().to_lowercase();
        let mut rows = report.with_value(|r| {
            r.analysis
                .routes
                .iter()
                .filter(|row| {
                    format!("{} {}", row.route_id, r.route_name(&row.route_id))
                        .to_lowercase()
                        .contains(&needle)
                })
                .cloned()
                .collect::<Vec<_>>()
        });
        rows.sort_by(|a, b| {
            let order = match sort.get() {
                "route" => a.route_id.cmp(&b.route_id),
                "vehicles" => a.vehicles.cmp(&b.vehicles),
                "trips" => a.trip_ids.cmp(&b.trip_ids),
                "hours" => a.hours.cmp(&b.hours),
                _ => a.observations.cmp(&b.observations),
            };
            if ascending.get() {
                order
            } else {
                order.reverse()
            }
        });
        rows
    };
    view! {
        <section><div class="section-heading"><div><h3>"Every route, a closer look"</h3><p>"Sort a column or select a route. Counts describe archive activity."</p></div><label class="search-label"><span class="sr-only">"Find a route"</span><input type="search" aria-label="Find a route" placeholder="Find a route…" on:input=move |ev| { search.set(event_target_value(&ev)); limit.set(20); }/></label></div>
            <div class="table-scroll" tabindex="0" role="region" aria-label="Route activity table"><table class="routes-table"><thead><tr>{[("route", "Route"), ("observations", "Observations"), ("vehicles", "Vehicles"), ("trips", "Trip IDs"), ("hours", "Hours")].into_iter().map(|(key, label)| view! {
                <th aria-sort=move || if sort.get() == key { if ascending.get() { "ascending" } else { "descending" } } else { "none" }><button on:click=move |_| { if sort.get() == key { ascending.update(|v| *v = !*v); } else { sort.set(key); ascending.set(key == "route"); } }>{label}<svg class="icon sort-icon" viewBox="0 0 20 20" aria-hidden="true"><path d=move || if sort.get() != key { "M7 15V5m-3 3 3-3 3 3M13 5v10m-3-3 3 3 3-3" } else if ascending.get() { "M10 16V4m-5 5 5-5 5 5" } else { "M10 4v12m-5-5 5 5 5-5" }/></svg></button></th>
            }).collect_view()}<th>"Coordinates"</th></tr></thead><tbody>{move || filtered().into_iter().take(limit.get()).map(|row| {
                let id = row.route_id.clone(); let name = report.with_value(|r| r.route_name(&id)); let mode = report.with_value(|r| r.mode);
                view! { <tr><td><button class="route-table-link" disabled=move || ui.busy.get() on:click=move |_| ui.filter(mode, Some(id.clone()))><span class=format!("route-swatch {}", route_color(&row.route_id))></span><strong>{if row.route_id.is_empty() { "?" } else { &row.route_id }.to_owned()}</strong><span>{name}</span></button></td><td>{number(row.observations)}</td><td>{number(row.vehicles)}</td><td>{number(row.trip_ids)}</td><td>{row.hours}</td><td>{percent(row.valid_positions, row.observations)}</td></tr> }
            }).collect_view()}</tbody></table></div>
            <Show when=move || filtered().is_empty()><p class="inline-empty">"No routes match this search. Try another route ID or name."</p></Show>
            <div class="table-footer"><span>{move || format!("Showing {} of {} matching routes", limit.get().min(filtered().len()), filtered().len())}</span><Show when={move || filtered().len() > limit.get()}><button class="text-button" on:click=move |_| limit.update(|v| *v += 20)>"Show 20 more"</button></Show></div>
            <p class="caption">"Vehicles and trip IDs are distinct nonempty source IDs within each route; totals across rows are not additive. A trip ID is not a completed journey. Unknown route IDs are retained as “?”"</p>
        </section>
        <RouteHeatmap report=report.get_value()/>
    }
}

#[component]
fn RouteHeatmap(report: Arc<Report>) -> impl IntoView {
    let top = report.analysis.routes.iter().take(15).collect::<Vec<_>>();
    let heatmap_height = 40 + top.len() * 32;
    let max = report
        .analysis
        .route_hours
        .iter()
        .map(|r| r.observations)
        .max()
        .unwrap_or(1)
        .max(1);
    view! { <section class="heatmap-section"><div class="section-heading"><div><h3>"Route activity, hour by hour"</h3><p>"Up to 15 routes with the most observations. Darker cells contain more archive rows."</p></div></div><p class="chart-scroll-hint">"Scroll horizontally to see all 24 UTC hours."</p><div class="heatmap-scroll" tabindex="0" role="region" aria-label="Route hourly activity heatmap"><svg class="heatmap" viewBox=format!("0 0 1120 {}", heatmap_height) role="img" aria-label="Archived observation counts by route and UTC hour. Exact values are available in each cell’s title.">
    {(0..24).map(|h| view! { <text class="axis-label" x={90 + h * 42} y="17" text-anchor="middle">{format!("{h:02}")}</text> }).collect_view()}
    {top.into_iter().enumerate().map(|(i, row)| view! { <g><text class="heatmap-route" x="52" y={46 + i * 32} text-anchor="end">{if row.route_id.is_empty() { "?" } else { &row.route_id }.to_owned()}</text>{(0..24).map(|hour| {
        let count = report.analysis.route_hours.iter().find(|r| r.route_id == row.route_id && r.hour == hour).map_or(0, |r| r.observations);
        let level = if count == 0 { 0 } else { ((count as f64 / max as f64 * 4.0).ceil() as u32).max(1) };
        view! { <rect class=format!("heat-{level}") tabindex="0" x={71 + hour * 42} y={28 + i * 32} width="37" height="25" rx="2"><title>{format!("Route {} · {hour:02}:00 UTC · {} observations", row.route_id, number(count))}</title></rect> }
    }).collect_view()}</g> }).collect_view()}
    </svg></div><p class="caption">"All selected dates are pooled by UTC hour. This is observation density, not speed, frequency, or reliability."</p></section> }
}

#[component]
fn Positions(report: Arc<Report>) -> impl IntoView {
    let positions = &report.analysis.positions;
    let has_positions = !positions.is_empty();
    let selected = RwSignal::new(None::<Position>);
    let extent = positions.iter().fold(
        (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ),
        |(minx, maxx, miny, maxy), p| {
            (
                minx.min(p.longitude),
                maxx.max(p.longitude),
                miny.min(p.latitude),
                maxy.max(p.latitude),
            )
        },
    );
    let (minx, maxx, miny, maxy) = extent;
    let center_y = (miny + maxy) / 2.0;
    let cosine = center_y.to_radians().cos().abs().max(0.01);
    let range_x = ((maxx - minx) * cosine).max(0.002);
    let range_y = (maxy - miny).max(0.002);
    let scale = (960.0 / range_x).min(400.0 / range_y) * 0.88;
    let x = |lon: f64| 560.0 + (lon - (minx + maxx) / 2.0) * cosine * scale;
    let y = |lat: f64| 245.0 - (lat - center_y) * scale;
    let summary = report.summary();
    view! {
        <section><div class="section-heading"><div><h3>"Where vehicles last reported"</h3><p>"Latest archived report per vehicle in the current selection. These positions are not simultaneous."</p></div><span class="position-count">{format!("{} positions", number(positions.len() as u64))}</span></div>
            <div class="inline-empty" hidden=has_positions>{if summary.differential > 0 { "Position reconstruction is disabled because this selection includes differential feeds. The archive does not retain all deletion tombstones." } else { "No usable latest vehicle positions are available for these filters. Clear a filter or try another archive day." }}</div><div hidden=!has_positions>
                <p class="chart-scroll-hint">"Scroll horizontally to explore the position plot. Select a point for its details."</p><div class="position-plot" tabindex="0" role="region" aria-label="Scrollable geographic position plot"><svg viewBox="0 0 1120 490" role="group" aria-label="Geographic plot of latest archived vehicle positions, with longitude and latitude axes; no basemap is used.">
                    {(0..=4).map(|i| {
                        let fraction = i as f64 / 4.0; let lon = minx + (maxx - minx) * fraction; let lat = miny + (maxy - miny) * fraction;
                        view! { <g><line class="map-grid" x1=x(lon) x2=x(lon) y1="35" y2="445"/><line class="map-grid" x1="75" x2="1070" y1=y(lat) y2=y(lat)/><text class="axis-label" x=x(lon) y="470" text-anchor="middle">{format!("{lon:.3}°")}</text><text class="axis-label" x="65" y=y(lat) text-anchor="end">{format!("{lat:.3}°")}</text></g> }
                    }).collect_view()}
                    {positions.iter().map(|p| { let click = p.clone(); let focus = p.clone(); let title = format!("Vehicle {} · route {} · {}", p.vehicle_id, if p.route_id.is_empty() { "unreported" } else { &p.route_id }, p.observed_at.as_deref().unwrap_or(&p.fetch_at)); view! { <circle class=format!("vehicle-point {}", route_color(&p.route_id)) cx=x(p.longitude) cy=y(p.latitude) r="4.5" role="button" tabindex="0" aria-label=title.clone() on:click=move |_| selected.set(Some(click.clone())) on:focus=move |_| selected.set(Some(focus.clone()))><title>{title.clone()}</title></circle> } }).collect_view()}
                </svg></div>
                <div class="position-detail" role="status">{move || selected.get().map(|p| format!("Vehicle {} · Route {} · {:.5}°, {:.5}° · {} ({})", p.vehicle_id, if p.route_id.is_empty() { "unreported" } else { &p.route_id }, p.latitude, p.longitude, p.observed_at.as_deref().unwrap_or(&p.fetch_at), p.time_source)).unwrap_or_else(|| "Select a point to inspect its vehicle, route, coordinates, and timestamp.".into())}</div>
            </div>
            <p class="caption">"Coordinate plot with a local equirectangular projection; no basemap or external map requests. Colors distinguish route IDs. Latest is selected by fetch time, then vehicle time and source identity. Invalid coordinates and vehicles without IDs are excluded."</p>
            <p class="caption">"At most 5,000 vehicles, ordered by ID, are drawn. The last report can be old; this view is an archive explorer, not a live tracker."</p>
        </section>
    }
}

#[component]
fn Sources(report: Arc<Report>) -> impl IntoView {
    let report = StoredValue::new(report);
    view! {
        <section><div class="section-heading"><div><h3>"Follow the data"</h3><p>"Exact inputs, calculation rules, and SQL for this result."</p></div><button class="secondary" on:click=move |_| export_evidence(&report.get_value())>"Download provenance"</button></div>
            <dl class="provenance-grid"><div><dt>"Source"</dt><dd>"Public gtfsrt.io Parquet archive"</dd></div><div><dt>"Object check"</dt><dd>{report.with_value(|r| r.prepared.checked_at.clone())}</dd></div><div><dt>"Metric contract"</dt><dd>{METRIC_VERSION}</dd></div><div><dt>"Execution"</dt><dd>"Rust application + DuckDB v2.0.0 · this browser"</dd></div></dl>
            <div class="table-scroll" tabindex="0" role="region" aria-label="Queried daily archive files"><table><thead><tr><th>"UTC day"</th><th>"Object status"</th><th>"Compressed size"</th><th>"Source"</th></tr></thead><tbody>{report.with_value(|r| r.prepared.files.iter().map(|file| view! { <tr><td>{file.date.clone()}</td><td>{file.status.clone()}</td><td>{format!("{:.2} MiB", file.bytes as f64 / 1_048_576.0)}</td><td><a href=file.url.clone() target="_blank" rel="noopener noreferrer">"Parquet object"<ExternalLink/></a></td></tr> }).collect_view())}</tbody></table></div>
            <div class="method-copy"><h4>"What is counted"</h4><p>"Observations are raw archived vehicle-position rows, including repeated polls. Vehicles, routes, and trip IDs count distinct nonempty source IDs within this single feed. No arrival events, completed journeys, cancellations, ridership, speeds, or on-time performance are inferred."</p><h4>"Coverage and time"</h4><p>"Dates and charts use UTC fetch time. Local days and GTFS service dates differ. Hours with records need only one record; this is not a completeness score. Missing files remain visible and are excluded from the calculation."</p><h4>"Coordinates and repeated fixes"</h4><p>"Usable coordinates fall within geographic bounds and exclude (0, 0). Repeated fixes share vehicle, route, trip, vehicle timestamp, and coordinates; they are counted for quality inspection and retained in observation totals. Missing or zero vehicle times are reported separately."</p><h4>"Historical route metadata"</h4><p>{report.with_value(|r| r.schedule.as_ref().map_or_else(|| "No unambiguous historical schedule was matched. Mode filtering is disabled.".into(), |s| format!("Names and GTFS route types use {} (retrieved {}). This version advertises coverage of the full selection and was retrieved before it. Route IDs are matched within this single schedule source; unmatched IDs remain visible. This does not validate trip or stop-event joins.", s.digest, s.retrieved)))}</p>
                <h4>"Browser resource limits"</h4><p>"At most six daily objects and 128 MiB of compressed raw objects, checked before SQL. Auxiliary metadata files are limited to 2 MiB each. DuckDB’s memory target is 512 MB; total tab memory can be higher. Queries request cancellation at 15 seconds and reset the worker at 30 seconds. Cancel immediately terminates the worker and clears the local database."</p><h4>"Privacy and storage"</h4><p>"The website serves application files. Transit data is requested directly from Google’s public archive hosting and processed on your device. Google receives your network address and object requests. There is no analytics, data upload, persistent database, or external map provider. Your browser may keep ordinary HTTP cache entries. Reloading clears the working database."</p>
            </div>
            <Show when=move || report.with_value(|r| !r.warnings.is_empty())><div class="source-warnings"><h4>"Source limitations"</h4><ul>{report.with_value(|r| r.warnings.iter().map(|warning| view! { <li>{warning.clone()}</li> }).collect_view())}</ul></div></Show>
        </section>
        <section class="sql-section"><h3>"The SQL behind this view"</h3><p>"Read-only inspection. Source text and filter values cannot change these fixed query templates."</p>{report.with_value(|r| r.sql.iter().map(|(name, sql)| view! { <details class="sql-query"><summary>{name.clone()}</summary><pre><code>{sql.clone()}</code></pre></details> }).collect_view())}</section>
    }
}

fn export_routes(report: &Report) {
    let mut csv = "route_id,route_name,mode,observations,distinct_vehicle_ids,distinct_trip_ids,utc_hours_with_records,valid_coordinate_rows\r\n".to_owned();
    for row in &report.analysis.routes {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{}\r\n",
            csv_cell(&row.route_id),
            csv_cell(&report.route_name(&row.route_id)),
            csv_cell(report.route_mode(&row.route_id).label()),
            row.observations,
            row.vehicles,
            row.trip_ids,
            row.hours,
            row.valid_positions
        ));
    }
    download_file(
        &format!(
            "transit-routes-{}-{}.csv",
            report.selection.from, report.selection.to
        ),
        &csv,
        "text/csv;charset=utf-8",
    );
}

fn export_evidence(report: &Report) {
    let value = serde_json::json!({"metric_version": METRIC_VERSION, "selection": report.selection, "filters": {"mode": report.mode, "route": report.route}, "files": report.prepared.files, "checked_at": report.prepared.checked_at, "schema_columns": report.prepared.columns, "schedule": report.schedule, "route_metadata": report.route_metadata, "engine_version": report.prepared.engine_version, "sql": report.sql, "warnings": report.warnings, "results": report.analysis});
    if let Ok(json) = serde_json::to_string_pretty(&value) {
        download_file(
            &format!("transit-provenance-{}.json", report.selection.from),
            &json,
            "application/json",
        );
    }
}

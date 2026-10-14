import './howmany.css';

const number = value =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
const count = (value, noun) => `${number(value)} ${noun}${value === 1 ? '' : 's'}`;
const bytes = value =>
  value < 1024
    ? `${number(value)} B`
    : value < 1024 * 1024
      ? `${number(value / 1024)} KB`
      : `${number(value / (1024 * 1024))} MB`;
const languages = {
  js: 'JavaScript',
  mjs: 'JavaScript modules',
  cjs: 'CommonJS',
  ts: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  ex: 'Elixir',
  exs: 'Elixir scripts',
  swift: 'Swift',
  md: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  no_ext: 'Extensionless',
};
const categories = [
  ['code_lines', 'Code'],
  ['doc_lines', 'Documentation'],
  ['comment_lines', 'Comments'],
  ['blank_lines', 'Blank'],
];
const scores = [
  ['maintainability_score', 'Maintainability'],
  ['documentation_score', 'Documentation'],
  ['readability_score', 'Readability'],
  ['consistency_score', 'Consistency'],
];
const band = value => (value >= 85 ? 'high' : value >= 70 ? 'good' : value >= 55 ? 'fair' : 'low');

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function row(label, value, className = '') {
  const element = node('div', `howmany-row ${className}`);
  element.append(node('span', '', label), node('span', 'howmany-value', value));
  return element;
}
function section(title) {
  const element = node('section', 'howmany-section');
  element.append(node('h3', '', title));
  return element;
}
function composition(basic) {
  const bar = node('div', 'howmany-composition');
  bar.setAttribute('aria-label', 'Line composition');
  for (const [key, label] of categories) {
    const part = node('span', `howmany-${key}`);
    part.style.width = `${basic.total_lines ? (basic[key] / basic.total_lines) * 100 : 0}%`;
    part.title = `${number(basic[key])} ${label.toLowerCase()} lines`;
    bar.append(part);
  }
  return bar;
}

/** Native explorer summary and report; all counts and scores come from HowMany. */
export function createHowMany(monaco, api, navigator, statusbar) {
  if (!api?.howmany) return { analyze() {}, updateFile() {}, clearFile() {}, dispose() {} };
  const panel = node('details', 'howmany-panel');
  panel.id = 'howmany-panel';
  panel.open = true;
  panel.innerHTML =
    '<summary><span>HowMany</span><span class="howmany-summary"></span></summary><div class="howmany-body"></div><div class="howmany-actions"><button type="button" class="howmany-report-button">Full report</button><button type="button" class="howmany-refresh" aria-label="Refresh HowMany analysis" title="Refresh analysis">↻</button></div>';
  navigator.querySelector('.navigator-footer').before(panel);
  const summary = panel.querySelector('.howmany-summary');
  const body = panel.querySelector('.howmany-body');
  const refresh = panel.querySelector('.howmany-refresh');
  const status = node('button', 'howmany-status', 'HowMany');
  status.type = 'button';
  status.title = 'Open HowMany analysis';
  statusbar.prepend(status);
  const dialog = node('dialog', 'howmany-dialog');
  dialog.id = 'howmany-report';
  dialog.setAttribute('aria-labelledby', 'howmany-title');
  dialog.innerHTML =
    '<header><div><h2 id="howmany-title">HowMany</h2><p>Workspace analysis</p></div><button type="button" class="howmany-close" aria-label="Close HowMany report">×</button></header><div class="howmany-report-content"></div><footer><span class="howmany-report-state" role="status"></span><button type="button" class="howmany-export">Export JSON</button><button type="button" class="howmany-report-refresh">Refresh</button></footer>';
  document.body.append(dialog);
  const content = dialog.querySelector('.howmany-report-content');
  const reportState = dialog.querySelector('.howmany-report-state');
  let state = { status: 'idle', report: null, message: '' };
  let active = null;
  let fileRequest = 0;
  let disposed = false;

  function renderReport() {
    content.replaceChildren();
    dialog.querySelector('.howmany-export').disabled = !state.report;
    dialog.querySelector('.howmany-report-refresh').disabled = state.status === 'analyzing';
    reportState.textContent =
      state.status === 'analyzing'
        ? 'Analyzing…'
        : state.message ||
          (state.updatedAt
            ? `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · HowMany ${state.report?.metadata?.version ?? ''}`
            : '');
    if (!state.report) {
      content.append(
        node('p', 'howmany-empty', state.message || 'Counting files and analyzing code…'),
      );
      return;
    }
    const { basic, ratios, complexity } = state.report;
    const overview = section(count(basic.total_lines, 'line'));
    overview.append(
      node(
        'p',
        'howmany-muted',
        `${count(basic.total_files, 'file')} · ${bytes(basic.total_size)} · ${number(basic.average_lines_per_file)} lines per file`,
      ),
      composition(basic),
    );
    for (const [key, label] of categories)
      overview.append(
        row(
          label,
          `${number(basic[key])} · ${basic.total_lines ? ((basic[key] / basic.total_lines) * 100).toFixed(1) : '0'}%`,
          key,
        ),
      );
    content.append(overview);
    const quality = ratios?.quality_metrics;
    if (Number.isFinite(quality?.overall_quality_score) && basic.total_files > 0) {
      const group = section(`Quality ${Math.round(quality.overall_quality_score)} / 100`);
      group.dataset.band = band(quality.overall_quality_score);
      for (const [key, label] of scores)
        if (Number.isFinite(quality[key]))
          group.append(row(label, `${Math.round(quality[key])} / 100`));
      content.append(group);
    }
    const extensions = Object.entries(basic.stats_by_extension ?? {})
      .filter(([, stats]) => Number.isFinite(stats.total_lines))
      .sort((a, b) => b[1].total_lines - a[1].total_lines);
    if (extensions.length) {
      const group = section('Languages');
      for (const [extension, stats] of extensions) {
        const line = row(
          languages[extension] ?? extension,
          `${count(stats.total_lines, 'line')} · ${count(stats.file_count, 'file')}`,
        );
        line.title = `${basic.total_lines ? ((stats.total_lines / basic.total_lines) * 100).toFixed(1) : 0}% of all lines`;
        group.append(line);
      }
      content.append(group);
    }
    // The CLI can return an entirely zeroed block when no structural parser ran.
    if (complexity?.function_count > 0 || complexity?.total_structures > 0) {
      const group = section('Structure & complexity');
      for (const [key, label] of [
        ['function_count', 'Functions'],
        ['total_structures', 'Structures'],
        ['cyclomatic_complexity', 'Average cyclomatic complexity'],
        ['cognitive_complexity', 'Average cognitive complexity'],
        ['average_function_length', 'Average function length'],
        ['max_nesting_depth', 'Maximum nesting depth'],
      ]) {
        if (Number.isFinite(complexity[key])) group.append(row(label, number(complexity[key])));
      }
      content.append(group);
    }
  }

  function render(next) {
    if (disposed) return;
    state = next;
    body.replaceChildren();
    const { report, message } = state;
    const running = state.status === 'analyzing';
    refresh.disabled = running;
    panel.setAttribute('aria-busy', String(running));
    summary.textContent = running
      ? 'Analyzing…'
      : report
        ? count(report.basic.total_lines, 'line')
        : '';
    status.textContent = running
      ? 'HowMany…'
      : report
        ? `${number(report.basic.code_lines)} code`
        : 'HowMany';
    status.title = message || 'Open HowMany workspace analysis';
    if (report) {
      const { basic } = report;
      body.append(
        row(count(basic.total_files, 'file'), count(basic.total_lines, 'line')),
        composition(basic),
      );
      for (const [key, label] of categories)
        if (basic[key]) body.append(row(label, number(basic[key])));
      const quality = report.ratios?.quality_metrics?.overall_quality_score;
      if (Number.isFinite(quality) && basic.total_files > 0) {
        const score = row('Quality', `${Math.round(quality)} / 100`, 'howmany-quality');
        score.dataset.band = band(quality);
        body.append(score);
      }
    }
    if (message || !report) body.append(node('p', 'howmany-empty', message || 'Counting files…'));
    if (dialog.open) renderReport();
  }

  async function analyze(force = false) {
    try {
      render(await api.howmany.analyze(force));
    } catch (error) {
      render({ ...state, status: 'error', message: error.message });
    }
  }
  function showReport() {
    renderReport();
    if (!dialog.open) dialog.showModal();
  }
  async function refreshAnalysis() {
    await analyze(true);
    if (active?.document) void updateFile(active, active.document, true);
  }
  panel.querySelector('.howmany-report-button').addEventListener('click', showReport);
  status.addEventListener('click', showReport);
  refresh.addEventListener('click', () => void refreshAnalysis());
  dialog
    .querySelector('.howmany-report-refresh')
    .addEventListener('click', () => void refreshAnalysis());
  dialog.querySelector('.howmany-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  });
  dialog.querySelector('.howmany-export').addEventListener('click', async () => {
    try {
      const result = await api.howmany.export();
      if (result) reportState.textContent = 'Report exported';
    } catch (error) {
      reportState.textContent = error.message;
    }
  });
  const unsubscribe = api.howmany.onEvent(event => {
    if (event.type === 'analysis') render(event);
    if (event.type === 'file' && active?.file.path === event.path && active.model) {
      const model = active.model;
      // HowMany owns separate markers so language-server diagnostics remain visible.
      monaco.editor.setModelMarkers(
        model,
        'howmany',
        (event.diagnostics ?? []).map(diagnostic => ({
          startLineNumber: diagnostic.range.start.line + 1,
          startColumn: diagnostic.range.start.character + 1,
          endLineNumber: diagnostic.range.end.line + 1,
          endColumn: diagnostic.range.end.character + 1,
          message: diagnostic.message,
          severity: monaco.MarkerSeverity.Warning,
          source: 'HowMany',
          code: diagnostic.code,
        })),
      );
      const warnings = active.element.querySelector('.howmany-warnings');
      warnings.textContent = (event.diagnostics ?? []).map(value => value.message).join(' · ');
      warnings.hidden = !warnings.textContent;
    }
  });

  function clearFile(card = active) {
    if (!card || card !== active) return;
    fileRequest++;
    active = null;
    card.howmanyVersion = null;
    if (card.model) monaco.editor.setModelMarkers(card.model, 'howmany', []);
    void api.howmany.close(card.file.path).catch(() => {});
  }
  async function updateFile(card, document, force = false) {
    const version = card.model.getVersionId();
    if (!force && !document.note && active === card && card.howmanyVersion === version) return;
    active = card;
    card.howmanyVersion = version;
    const request = ++fileRequest;
    const counts = card.element.querySelector('.howmany-counts');
    const warnings = card.element.querySelector('.howmany-warnings');
    counts.hidden = true;
    warnings.hidden = true;
    if (document.note) {
      clearFile(card);
      return;
    }
    try {
      const result = await api.howmany.file(card.file.path);
      if (
        disposed ||
        request !== fileRequest ||
        !card.active ||
        card.model?.getVersionId() !== version
      )
        return;
      if (!result || result.message) card.howmanyVersion = null;
      counts.textContent = result?.title ?? '';
      counts.hidden = !counts.textContent;
      counts.title = result?.live
        ? 'Counted by HowMany from the displayed file'
        : 'Counted by HowMany from the saved file';
    } catch {
      if (request === fileRequest) card.howmanyVersion = null;
      /* Missing tools never prevent a file from opening. */
    }
  }
  return {
    analyze,
    updateFile,
    clearFile,
    dispose() {
      disposed = true;
      clearFile();
      unsubscribe();
      dialog.remove();
      panel.remove();
      status.remove();
    },
  };
}

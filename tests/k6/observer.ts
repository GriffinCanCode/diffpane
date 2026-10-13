import type { Page } from 'playwright';

export type Expectation = { path: string; absent?: string; marker?: string; deleted?: boolean };

/** Test-only observer: DOM conditions must survive a browser paint opportunity. */
export async function installObserver(page: Page, observed: (id: number) => void) {
  await page.exposeBinding('__k6Observed', (_source, id: number) => observed(id));
  await page.evaluate(() => {
    const state = window as unknown as {
      __k6Observed: (id: number) => Promise<void>;
      __k6Expectations: Map<
        number,
        { path: string; absent?: string; marker?: string; deleted?: boolean }
      >;
      __k6Observe: () => void;
      __k6Frames: { count: number; maxMs: number; over100Ms: number };
    };
    state.__k6Expectations = new Map();
    state.__k6Frames = { count: 0, maxMs: 0, over100Ms: 0 };
    let previous = performance.now();
    const frame = (now: number) => {
      const elapsed = now - previous;
      state.__k6Frames.count++;
      state.__k6Frames.maxMs = Math.max(state.__k6Frames.maxMs, elapsed);
      if (elapsed > 100) state.__k6Frames.over100Ms++;
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    let scheduled = false;
    state.__k6Observe = () => {
      if (scheduled || !state.__k6Expectations.size) return;
      scheduled = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scheduled = false;
          const paths = new Set(
            Array.from(
              document.querySelectorAll<HTMLElement>('.navigator-row[data-kind="file"]'),
              row => row.dataset.path,
            ),
          );
          const text = document.querySelector('.view-lines')?.textContent || '';
          for (const [id, expectation] of state.__k6Expectations) {
            const ready = expectation.marker
              ? text.includes(expectation.marker)
              : expectation.deleted
                ? !paths.has(expectation.path)
                : paths.has(expectation.path) &&
                  (!expectation.absent || !paths.has(expectation.absent));
            if (ready) {
              state.__k6Expectations.delete(id);
              void state.__k6Observed(id);
            }
          }
        }),
      );
    };
    new MutationObserver(state.__k6Observe).observe(document.querySelector('#app')!, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-path'],
    });
  });
}

export async function armObserver(page: Page, id: number, expectation: Expectation) {
  await page.evaluate(
    ({ id, expectation }) => {
      const state = window as unknown as {
        __k6Expectations: Map<number, Expectation>;
        __k6Observe: () => void;
      };
      state.__k6Expectations.set(id, expectation);
      state.__k6Observe();
    },
    { id, expectation },
  );
}

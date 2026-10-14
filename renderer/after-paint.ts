/** Give visible content a paint opportunity before starting optional background work. */
export function afterPaint(run: () => void) {
  let frame: number | undefined;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canceled = false;
  const finish = () => {
    idle = undefined;
    timer = undefined;
    if (!canceled) run();
  };
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (typeof globalThis.requestIdleCallback === 'function')
        idle = requestIdleCallback(finish, { timeout: 1000 });
      else timer = setTimeout(finish, 0);
    });
  });
  return () => {
    canceled = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

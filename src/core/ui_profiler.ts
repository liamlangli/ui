// ui_profiler — runtime CPU profiling (core).
//
// A tiny instrumentation layer that records named, nested CPU zones per frame
// into a moving window (ring) of recent frames. The collection side lives in
// core so the renderer, widgets and host apps can all drop zones in; the
// inspection UI ships separately as the `profiler_panel` plugin, which renders
// the window as a timeline and lets you pause, select a slice and inspect it
// as a Chrome-performance-style flame chart.
//
// Usage (once per frame):
//
//   profiler.begin_frame()
//   profiler.begin('layout')
//   …
//   profiler.begin('text')       // nests under 'layout'
//   …
//   profiler.end()
//   profiler.end()
//   profiler.end_frame()
//
// `begin`/`end` are no-ops while paused or outside a frame, so instrumentation
// can stay in shipping code. A shared default instance (`profiler`) is
// exported so call sites don't need plumbing; hosts that want isolated
// captures can construct their own `ui_profiler`.

/** One closed (or still-open, while inside a frame) named zone. */
export interface profiler_span {
  name: string
  /** Absolute `performance.now()` timestamps, ms. */
  start_ms: number
  end_ms: number
  /** Nesting depth at `begin` time — row index in the flame chart. */
  depth: number
}

/** One recorded frame: its wall-clock bounds plus every zone closed inside it. */
export interface profiler_frame {
  /** Monotonic frame id. Contiguous across the buffer; gaps never occur (paused frames are simply not recorded). */
  index: number
  start_ms: number
  end_ms: number
  /** CPU time spent in the frame (`end_ms - start_ms`). */
  cpu_ms: number
  /** Spans in `begin` order (parents precede children). */
  spans: profiler_span[]
}

export class ui_profiler {
  /** Moving-window capacity, in frames. */
  max_frames: number
  /** Recorded frames, oldest first. Indices are contiguous. */
  frames: profiler_frame[] = []
  paused = false

  private next_index = 0
  private current: profiler_frame | null = null
  private open: profiler_span[] = []

  constructor(max_frames = 600) {
    this.max_frames = Math.max(2, max_frames)
  }

  /** Start recording a frame. No-op while paused. */
  begin_frame(now: number = performance.now()): void {
    if (this.paused) return
    this.current = { index: this.next_index, start_ms: now, end_ms: now, cpu_ms: 0, spans: [] }
    this.open.length = 0
  }

  /** Close the frame and commit it to the moving window. Open zones are closed at the frame edge. */
  end_frame(now: number = performance.now()): void {
    const frame = this.current
    if (!frame) return
    for (const span of this.open) span.end_ms = now // forgive unbalanced begin/end
    this.open.length = 0
    frame.end_ms = now
    frame.cpu_ms = now - frame.start_ms
    this.frames.push(frame)
    this.next_index += 1
    if (this.frames.length > this.max_frames) this.frames.splice(0, this.frames.length - this.max_frames)
    this.current = null
  }

  /** Open a named zone nested under the currently open one. No-op outside a frame. */
  begin(name: string, now: number = performance.now()): void {
    const frame = this.current
    if (!frame) return
    const span: profiler_span = { name, start_ms: now, end_ms: now, depth: this.open.length }
    frame.spans.push(span)
    this.open.push(span)
  }

  /** Close the innermost open zone. Unmatched calls are ignored. */
  end(now: number = performance.now()): void {
    const span = this.open.pop()
    if (span) span.end_ms = now
  }

  /** Run `fn` inside a zone — exception-safe begin/end pair. */
  zone<T>(name: string, fn: () => T): T {
    this.begin(name)
    try {
      return fn()
    } finally {
      this.end()
    }
  }

  /** Stop collecting. The window keeps its frames so they can be inspected. */
  pause(): void {
    this.paused = true
    // Drop a half-recorded frame rather than committing a torn one.
    this.current = null
    this.open.length = 0
  }

  resume(): void {
    this.paused = false
  }

  toggle(): void {
    if (this.paused) this.resume()
    else this.pause()
  }

  /** Drop every recorded frame (the frame id sequence keeps counting). */
  clear(): void {
    this.frames.length = 0
    this.current = null
    this.open.length = 0
  }

  /** Frame with id `index`, or null if it has been evicted / not yet recorded. */
  frame_by_index(index: number): profiler_frame | null {
    const first = this.frames[0]
    if (!first) return null
    const pos = index - first.index
    return pos >= 0 && pos < this.frames.length ? this.frames[pos] ?? null : null
  }

  /** Frames whose id falls in `[lo, hi]` (clamped to the window), oldest first. */
  frames_in_range(lo: number, hi: number): profiler_frame[] {
    const first = this.frames[0]
    if (!first || hi < lo) return []
    const a = Math.max(0, lo - first.index)
    const b = Math.min(this.frames.length - 1, hi - first.index)
    return a > b ? [] : this.frames.slice(a, b + 1)
  }
}

/** Shared default instance — instrument anywhere without plumbing a profiler through. */
export const profiler = new ui_profiler()

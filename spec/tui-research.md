# TUI Research: Interactive Mode for atlcli

## Overview

Research into building a first-class terminal UI experience for atlcli, covering both focused dashboard views and a general interactive TUI mode.

**Related Documents:**
- [Jira TUI Screen Designs](./jira-tui-design.md)
- [Confluence TUI Screen Designs](./tui-confluence-screens.md)

---

## Part 1: Competitive Analysis

### How Modern CLI Tools Implement TUI

| Tool | Framework | Language | Key Innovation |
|------|-----------|----------|----------------|
| **Claude Code** | React + Ink (custom renderer) | TypeScript | Differential rendering, preserves scrollback |
| **OpenCode** | OpenTUI (custom) | TypeScript + Zig | Hybrid arch - TS logic, Zig rendering |
| **Crush** | Bubble Tea + Lipgloss | Go | Spring animations, "glamorous" aesthetic |
| **Lazygit** | gocui + tcell | Go | Gold standard panels, vim bindings |
| **Lazydocker** | gocui + tcell | Go | Real-time stats, ASCII graphs |

### Framework Deep Dives

#### Claude Code (Anthropic)
- **Stack**: React + Ink with custom-built renderer (rewrote Ink's renderer for fine-grained control)
- **Layout**: Yoga (Facebook's flexbox engine)
- **Key decision**: Differential rendering instead of alternate screen mode
  - Preserves native terminal features (scrollback, text selection, search)
  - Trade-off: Known flickering issues (caused release rollback)
- **Spinner**: Custom flower animation: `· ✢ ✳ ∗ ✻ ✽`
- **Themes**: Dark/light with colorblind variants

#### OpenCode (SST)
- **Stack**: @opentui (custom library) with SolidJS reconciler
- **Architecture**: Three-tier (TypeScript API → FFI → Zig native)
- **Performance**: Sub-millisecond frames via:
  - Zig-compiled native modules for rendering
  - Frame diffing (only changed cells)
  - ANSI generation with run-length encoding
- **Layout**: Yoga for flexbox
- **Themes**: JSON-based with 62 color properties, auto-detects terminal background via OSC escape sequences

#### Crush (Charmbracelet)
- **Stack**: Bubble Tea (Elm Architecture) + Lipgloss styling
- **Philosophy**: "Make the command line glamorous"
- **Features**: Split-pane diff view, session persistence, multi-model support
- **Note**: Charmbracelet also maintains Harmonica (spring animation library) but Crush doesn't use it

#### Lazygit/Lazydocker
- **Stack**: gocui (fork) + tcell v2
- **Design principles**:
  1. State visibility over query-response
  2. Discoverability over memorization
  3. Transparency (log all underlying commands)
  4. Keyboard-first, mouse-supported
- **Navigation**: `1-5` direct panel, `Tab` cycle, `j/k` within panel, `?` help
- **Theming**: YAML config with border styles, Nerd Fonts support

---

## Part 2: Technology Recommendations

### Framework Options for TypeScript/Bun

| Option | Pros | Cons |
|--------|------|------|
| **Ink + React** | Familiar React model, good ecosystem | Flickering issues, performance overhead |
| **Ink + Custom Renderer** | Full control like Claude Code | Significant engineering effort |
| **@opentui** | Modern, performant, SolidJS | Young library, less documentation |
| **neo-blessed** | Battle-tested, widget-based | Older patterns, CJS |
| **terminal-kit** | Full-featured, no ncurses | Less React-like |
| **pi-tui** | Excellent differential rendering, CSI 2026 support | Newer, smaller ecosystem |

**Recommendation**: Start with **Ink** for rapid prototyping, consider custom renderer or @opentui for performance optimization later.

### Charting Libraries

| Use Case | Library | Notes |
|----------|---------|-------|
| Line charts (burndown) | `asciichart` | Zero deps, ASCII line-drawing chars |
| Bar charts (velocity) | `chartscii` or `simple-ascii-chart` | TypeScript, colors |
| Sparklines | `sparkly` | Minimal, sindresorhus quality |
| Full dashboards | `@pppp606/ink-chart` | If using Ink |
| High-res graphics | `drawille` | Braille patterns (2x4 subpixel) |

### Styling Libraries

| Library | Purpose |
|---------|---------|
| `chalk` or `ansis` | Color and style (ansis is Bun-compatible) |
| `gradient-string` | Color gradients for headers |
| `boxen` | Box drawing |
| `cli-spinners` | 70+ spinner styles |
| `ora` | Elegant async spinners |

---

## Part 3: Flickering Prevention (Critical)

### Root Causes

1. **Full-screen redraw strategy**: Clearing and rewriting entire screen on each update
2. **React/Ink rendering model**: Rebuilds entire layout on every state change
3. **ANSI escape sequence overhead**: ~189 KB/second in worst cases
4. **Terminal timing issues**: No synchronization between write and display

### Claude Code's Issues

- **4,000-6,700 scroll events per second** (vs 10-50 for vim)
- Caused **release rollback** due to user complaints
- Issues documented: #769, #9266, #9935, #10794, #12463

### Solutions

#### 1. Synchronized Output Protocol (CSI ?2026)
```typescript
const BSU = '\x1b[?2026h';  // Begin Synchronized Update
const ESU = '\x1b[?2026l';  // End Synchronized Update

function renderFrame(content: string): void {
    process.stdout.write(BSU + content + ESU);
}
```

**Supported**: Windows Terminal, Kitty, WezTerm, iTerm2, Alacritty (0.13+), Ghostty, Foot
**Not Supported**: GNOME Terminal, xterm.js
**Unknown**: Konsole

#### 2. Double Buffering
```typescript
class DoubleBuffer {
    private front: Cell[][];
    private back: Cell[][];

    draw(x: number, y: number, cell: Cell): void {
        this.back[y][x] = cell;
    }

    flush(): string {
        const diff = this.computeDiff(this.front, this.back);
        const output = this.generateANSI(diff);
        [this.front, this.back] = [this.back, this.front];
        return output;
    }
}
```

#### 3. Frame Rate Limiting
```typescript
const TARGET_FPS = 60;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS; // ~16.67ms

class FrameLimiter {
    private lastFrame = 0;
    private pendingRender = false;

    requestRender(): void {
        if (this.pendingRender) return;
        this.pendingRender = true;

        const delay = Math.max(0, FRAME_BUDGET_MS - (Date.now() - this.lastFrame));
        setTimeout(() => {
            this.pendingRender = false;
            this.lastFrame = Date.now();
            this.render();
        }, delay);
    }
}
```

#### 4. ANSI Optimization
```typescript
// Bad: Separate sequences
'\x1b[1m\x1b[31m'  // Bold, then red

// Good: Chained sequences
'\x1b[1;31m'  // Bold AND red in one

// Use run-length encoding for repeated styles
```

### Best Practices

1. **Overwrite, don't clear**: Never clear then redraw
2. **Single stdout write per frame**: Buffer all changes
3. **Use synchronized output**: Wrap in CSI ?2026h/l
4. **Limit to 60 FPS**: More isn't perceptible
5. **Diff-based updates**: Only redraw changed cells

### Alternate Screen vs Inline

| Aspect | Alternate Screen | Inline |
|--------|-----------------|--------|
| **Scrollback** | Lost during use | Preserved |
| **Native selection** | Broken | Works |
| **Search (Ctrl+F)** | Broken | Works |
| **Flicker control** | Easier | Harder |
| **Use case** | Full-screen apps | CLI tools |

**Recommendation**: Use alternate screen for full TUI mode, inline for dashboard widgets.

---

## Part 4: Terminal Compatibility

### Feature Support Matrix

| Terminal | True Color | Unicode | Mouse | Kitty KB |
|----------|------------|---------|-------|----------|
| iTerm2 | Yes | Full | Yes | No |
| Terminal.app | **NO** (256 only) | Full | Yes | No |
| Windows Terminal | Yes | Full | Yes | No |
| Alacritty | Yes | Full | Yes | Yes |
| Kitty | Yes | Full | Yes | Yes |
| WezTerm | Yes | Full | Yes | Yes |
| Ghostty | Yes | Full | Yes | Yes |
| GNOME Terminal | Yes | Full | Yes | No |

**Critical**: macOS Terminal.app lacks true color - must provide 256-color fallback.
**Note**: Terminal.app will gain true color support in macOS Tahoe (Fall 2025).

### Detection Strategy

```typescript
function detectCapabilities(): TerminalCapabilities {
  const TERM = process.env.TERM || '';
  const COLORTERM = process.env.COLORTERM || '';
  const TERM_PROGRAM = process.env.TERM_PROGRAM || '';

  const trueColor =
    COLORTERM === 'truecolor' ||
    COLORTERM === '24bit' ||
    !!process.env.WT_SESSION || // Windows Terminal
    TERM_PROGRAM === 'iTerm.app' ||
    TERM.includes('kitty') ||
    TERM.includes('alacritty');

  const isTerminalApp = TERM_PROGRAM === 'Apple_Terminal';

  return {
    trueColor: trueColor && !isTerminalApp,
    color256: trueColor || TERM.includes('256color'),
    unicode: !TERM.includes('dumb'),
    mouse: !TERM.includes('dumb')
  };
}
```

### Graceful Degradation

| Feature | Full Support | Fallback |
|---------|-------------|----------|
| True color | RGB colors | 256/16 color palette |
| Unicode borders | `╭╮╰╯│─` | `+---+\|` ASCII |
| Progress bars | `▓▒░` blocks | `[====   ]` ASCII |
| Sparklines | `▁▂▃▄▅▆▇█` | Numbers |

### tmux/SSH Considerations

```bash
# ~/.tmux.conf for true color passthrough
set -g default-terminal "tmux-256color"
set -sa terminal-overrides ",*:Tc"
set -g mouse on
```

- Kitty keyboard protocol not supported through tmux
- SSH adds latency - reduce update frequency
- Force PTY allocation: `ssh -t user@host "atlcli tui"`

---

## Part 5: Keyboard Navigation

### Philosophy: Hybrid Approach

- **Vim-style** for navigation (hjkl, g/G)
- **Emacs-style** for text input fields
- **Command palette** for discoverability
- **Context-sensitive actions** with consistent semantics

### Global Keys

| Key | Action |
|-----|--------|
| `q` | Quit |
| `?` | Show help |
| `Esc` | Cancel/Back |
| `Tab` / `Shift+Tab` | Cycle panels |
| `1-5` | Direct panel jump |
| `:` | Command mode |
| `/` | Filter/Search |
| `Ctrl+P` | Command palette |

### Navigation Keys

| Key | Action |
|-----|--------|
| `j` / `Down` | Move down |
| `k` / `Up` | Move up |
| `h` / `Left` | Previous panel |
| `l` / `Right` | Next panel |
| `Enter` | Select/Drill down |
| `Space` | Toggle/Primary action |
| `g` / `G` | Go to top/bottom |

### Jira Context Keys

| Key | Action | Mnemonic |
|-----|--------|----------|
| `c` | Create issue | **C**reate |
| `e` | Edit issue | **E**dit |
| `t` | Transition | **T**ransition |
| `a` | Assign | **A**ssign |
| `w` | Log work | **W**ork |
| `m` | Comment | **M**essage |
| `o` | Open in browser | **O**pen |

### Confluence Context Keys

| Key | Action | Mnemonic |
|-----|--------|----------|
| `c` | Create page | **C**reate |
| `e` | Edit page | **E**dit |
| `p` | Push changes | **P**ush |
| `u` | Pull changes | **U**pdate |
| `S` | Sync | **S**ync |
| `h` | History | **H**istory |

### Help Overlay Design

```
┌─ Keyboard Shortcuts ─────────────────────────────────────┐
│  Navigation               │  Actions                     │
│  ─────────────────────────│──────────────────────────    │
│  j/k or ↑/↓  Move         │  c      Create               │
│  h/l or ←/→  Panels       │  e      Edit                 │
│  Enter       Select       │  t      Transition           │
│  Space       Toggle       │  d      Delete               │
│  g/G         Top/Bottom   │  o      Open browser         │
│  /           Filter       │                              │
│  Esc         Back         │  Press any key to close      │
└──────────────────────────────────────────────────────────┘
```

### Command Palette

```
┌─ Command Palette ─────────────────────────────────────────┐
│  > jira crea                                              │
│  ─────────────────────────────────────────────────────────│
│  ▸ Jira: Create Issue                                c    │
│    Jira: Create Subtask                              cs   │
│    Confluence: Create Page                           C    │
└───────────────────────────────────────────────────────────┘
```

---

## Part 6: Screen Architecture

### Entry Points

```bash
# Full interactive TUI
atlcli tui

# Product-specific TUI
atlcli jira tui
atlcli wiki tui

# Focused dashboard mode
atlcli jira dashboard --board 123
```

### Main Layout

```
┌─ atlcli ────────────────────────────────────────────────────────────────┐
│  [1] Home    [2] Jira    [3] Confluence    [?] Help    [q] Quit         │
├────────────────────┬────────────────────────────────────────────────────┤
│   Navigation       │                                                    │
│   ──────────────   │         Main Content Area                          │
│   > My Issues      │         (Issue details, page preview, etc.)        │
│     Boards         │                                                    │
│     Sprints        │                                                    │
│     Epics          │                                                    │
│     Search         │                                                    │
├────────────────────┤                                                    │
│   Recent           │                                                    │
│   ──────────────   │                                                    │
│     PROJ-123       │                                                    │
│     PROJ-456       │                                                    │
└────────────────────┴────────────────────────────────────────────────────┘
│  [c]reate  [e]dit  [t]ransition  [Space] toggle  [/] filter  [?] help   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Screen Flow

```
                    ┌─────────────────────────────────────────┐
                    │              atlcli TUI                 │
                    │                                         │
                    │  ┌─────────┐      ┌─────────────┐      │
                    │  │  Jira   │ <--> │ Confluence  │      │
                    │  └────┬────┘      └──────┬──────┘      │
                    │       │                  │              │
                    │       v                  v              │
                    │  ┌─────────┐      ┌─────────────┐      │
                    │  │ Home    │      │   Home      │      │
                    │  └────┬────┘      └──────┬──────┘      │
                    │       │                  │              │
                    │  ┌────┴────┐      ┌──────┴──────┐      │
                    │  v         v      v             v      │
                    │ Boards   Issues  Pages      Spaces     │
                    │   │         │      │             │      │
                    │   v         v      v             v      │
                    │ Sprint   Detail  Detail      Tree      │
                    └─────────────────────────────────────────┘
```

### Detailed Screen Designs

See companion documents:
- **[Jira TUI Screens](./jira-tui-design.md)**: Dashboard, issue list, detail, board/kanban, sprint, search
- **[Confluence TUI Screens](./tui-confluence-screens.md)**: Home, space browser, page tree, detail, search, sync status

---

## Part 7: Implementation Plan

### Phase 1: Foundation
1. Basic screen framework with navigation stack
2. Keyboard input handling (global + context)
3. Terminal capability detection
4. Product tab switching (Jira/Confluence)

### Phase 2: Core Screens
1. Jira: Issue list with filtering
2. Jira: Issue detail view
3. Confluence: Page tree browser
4. Confluence: Page detail view

### Phase 3: Advanced Features
1. Jira: Board/Kanban view
2. Jira: Sprint burndown charts
3. Confluence: Sync status view
4. Command palette

### Phase 4: Polish
1. Themes (dark, light, high-contrast)
2. Customizable keybindings
3. Session persistence
4. Performance optimization

---

## Part 8: Open Questions

### Resolved

- [x] **Flickering prevention**: Use synchronized output + double buffering + 60fps limit
- [x] **Terminal compatibility**: Detection + graceful degradation
- [x] **Keyboard scheme**: Hybrid vim/emacs with command palette

### Still Open

1. **Framework choice**: Ink vs pi-tui vs custom?
   - Ink: Faster to prototype, known flickering issues
   - pi-tui: Best differential rendering, newer
   - Custom: Most control, most effort

2. **Bundle size impact**: How much does TUI add?
   - Consider lazy-loading TUI module
   - Measure with current deps

3. **Offline mode**: Cache API responses?
   - Instant display of cached data
   - Background refresh with staleness indicator

4. **Testing strategy**: How to test TUI?
   - Microsoft's tui-test framework
   - Virtual terminal for unit tests
   - Manual testing matrix

---

## References

### Flickering
- [The Signature Flicker](https://steipete.me/posts/2025/signature-flicker) - Claude Code analysis
- [Terminal Synchronized Output Spec](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036)
- [Textual: Algorithms for High Performance](https://textual.textualize.io/blog/2024/12/12/algorithms-for-high-performance-terminal-apps/)

### Frameworks
- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [OpenTUI](https://github.com/sst/opentui) - Modern TypeScript TUI
- [Bubble Tea](https://github.com/charmbracelet/bubbletea) - Go TUI framework
- [pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui) - Differential rendering

### Design Patterns
- [Lazygit Turns 5](https://jesseduffield.com/Lazygit-5-Years-On/) - TUI design principles
- [K9s Documentation](https://k9scli.io/) - Multi-resource navigation
- [Command Palette UX](https://maggieappleton.com/command-bar) - Discoverability patterns

### Terminal Compatibility
- [True Color Terminals](https://gist.github.com/kurahaupo/6ce0eaefe5e730841f03cb82b061daa2)
- [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
- [Microsoft TUI Test](https://github.com/microsoft/tui-test)

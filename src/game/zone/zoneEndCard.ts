import type { ZoneResult } from './zoneRules';

/**
 * The end card of the `zone` mode. Before it the verdict was only canvas text
 * ("CHIẾN THẮNG") over a match with nothing left to do: no way to a new match
 * or the menu short of the death panel's checkpoint button.
 *
 * `zoneEndCardView` is the whole decision and is pure; `ZoneEndCard` is the
 * thin DOM around it. Every button answers touch as well as click —
 * `GameScene` calls `preventDefault()` on every touch on the page.
 */
export type ZoneEndAction = 'rematch' | 'menu' | 'watch';

export interface ZoneEndCardView {
  title: string;
  line: string;
  tone: 'win' | 'loss' | 'draw';
  actions: ZoneEndAction[];
}

export function zoneEndCardView(
  result: ZoneResult,
  playerTeam: string | undefined,
  netClient: boolean
): ZoneEndCardView | null {
  if (!result) return null;
  // A LAN client does not own the match, so it cannot restart it.
  const actions: ZoneEndAction[] = netClient ? ['menu', 'watch'] : ['rematch', 'menu', 'watch'];
  if ('draw' in result) {
    return { title: 'HÒA', line: 'Không còn ai sống sót trong vùng độc.', tone: 'draw', actions };
  }
  const won = result.winner === playerTeam;
  return {
    title: won ? 'CHIẾN THẮNG' : 'THẤT BẠI',
    line: won ? 'Đội bạn là đội cuối cùng còn đứng.' : 'Đội bạn đã bị loại khỏi vùng độc.',
    tone: won ? 'win' : 'loss',
    actions,
  };
}

const LABEL: Record<ZoneEndAction, string> = {
  rematch: 'Trận mới',
  menu: 'Về menu',
  watch: 'Xem tiếp',
};

const TONE: Record<ZoneEndCardView['tone'], string> = {
  win: '#ffd36b',
  loss: '#ff8a7a',
  draw: '#cfd8e3',
};

export interface ZoneEndHandlers {
  rematch: () => void;
  menu: () => void;
}

export class ZoneEndCard {
  private root: HTMLElement | null = null;
  /** Shown once per match; "Xem tiếp" hides it for good. */
  private done = false;

  constructor(private readonly handlers: ZoneEndHandlers) {}

  /** True while the card is up; the canvas verdict stays out from under it. */
  get visible(): boolean {
    return this.root !== null;
  }

  sync(view: ZoneEndCardView | null): void {
    if (this.done || !view || this.root || typeof document === 'undefined') return;
    this.root = this.build(view);
    document.body.appendChild(this.root);
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }

  private build(view: ZoneEndCardView): HTMLElement {
    const root = document.createElement('div');
    root.id = 'zone-end-card';
    root.style.cssText =
      'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(6,10,20,.62);font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;color:#f4efe2';
    const card = document.createElement('div');
    card.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px 30px;max-width:calc(100vw - 32px);' +
      `border-radius:18px;background:rgba(14,22,38,.94);border:2px solid ${TONE[view.tone]};box-shadow:0 12px 40px rgba(0,0,0,.5)`;
    const title = document.createElement('h1');
    title.textContent = view.title;
    title.style.cssText = `margin:0;font-size:clamp(30px,7vh,56px);letter-spacing:.08em;color:${TONE[view.tone]};text-shadow:0 3px 0 rgba(0,0,0,.45)`;
    const line = document.createElement('p');
    line.textContent = view.line;
    line.style.cssText = 'margin:0;font-size:15px;opacity:.85;text-align:center';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px';
    for (const action of view.actions) row.appendChild(this.button(action, view.tone));
    card.append(title, line, row);
    root.appendChild(card);
    return root;
  }

  private button(action: ZoneEndAction, tone: ZoneEndCardView['tone']): HTMLElement {
    const button = document.createElement('button');
    button.id = `zone-end-${action}`;
    button.textContent = LABEL[action];
    const primary = action === 'rematch';
    button.style.cssText =
      'font:inherit;font-weight:800;font-size:16px;min-width:120px;min-height:46px;border-radius:12px;cursor:pointer;' +
      (primary
        ? `border:2px solid ${TONE[tone]};background:${TONE[tone]};color:#0e1626`
        : 'border:2px solid rgba(244,239,226,.35);background:transparent;color:#f4efe2');
    let fired = false;
    const run = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (fired) return;
      fired = true;
      // Gone before the transition: a card left up over the next match eats every click.
      this.done = true;
      this.destroy();
      if (action === 'rematch') this.handlers.rematch();
      else if (action === 'menu') this.handlers.menu();
    };
    button.addEventListener('click', run);
    button.addEventListener('touchend', run);
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    return button;
  }
}

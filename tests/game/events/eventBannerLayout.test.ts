import { describe, expect, it } from 'vitest';
import { eventBannerLayout, eventTitleLayout } from '@/game/events/eventVfx';

/**
 * "Banner event trên mobile nó che giữa màn hình luôn, sao đánh nhau combat
 * đc": a landscape phone is ~412 CSS px tall, and the desktop banner — 62px
 * tall at y 100 — sat across 25–40% of it, over the fight. The centre title
 * (58px at 30% height) did the same when the event began.
 */
describe('the event banner leaves the fight visible', () => {
  const PHONE = { w: 915, h: 412 };
  const DESKTOP = { w: 1280, h: 800 };

  it('on a landscape phone, is one slim line hugging the top edge', () => {
    const b = eventBannerLayout(PHONE.w, PHONE.h);
    expect(b.compact).toBe(true);
    // Its whole box stays in the top 18% — clear of the champion at centre.
    expect(b.y + b.h).toBeLessThanOrEqual(PHONE.h * 0.18);
    expect(b.h).toBeLessThanOrEqual(32);
    // Narrow enough to leave the minimap (left) and the shop buttons (right) alone.
    expect(b.w).toBeLessThanOrEqual(PHONE.w * 0.4);
  });

  it('on a landscape phone, the start title stays in the top quarter and modest', () => {
    const t = eventTitleLayout(PHONE.w, PHONE.h);
    expect(t.cy + t.size * 1.3).toBeLessThanOrEqual(PHONE.h * 0.3);
    expect(t.size).toBeLessThanOrEqual(34);
  });

  it('on a desktop, is the full panel it always was', () => {
    const b = eventBannerLayout(DESKTOP.w, DESKTOP.h);
    expect(b).toMatchObject({ compact: false, y: 100, h: 62, w: 440 });
    const t = eventTitleLayout(DESKTOP.w, DESKTOP.h);
    expect(t).toMatchObject({ size: 58, cy: DESKTOP.h * 0.3 });
  });
});

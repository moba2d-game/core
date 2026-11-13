/**
 * The zone mode ended in canvas text alone ("CHIẾN THẮNG") with no way to a new
 * match or the menu. `zoneEndCardView` decides the card; `Game.drawZoneBanner`
 * must show it once there is a verdict.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zoneEndCardView } from '../../../src/game/zone/zoneEndCard';

describe('the zone end card', () => {
  it('says nothing while the match is still running', () => {
    expect(zoneEndCardView(null, 'team-blue', false)).toBeNull();
  });

  it('offers a new match, the menu and watching on, to the winner and the loser', () => {
    const won = zoneEndCardView({ winner: 'team-blue' } as never, 'team-blue', false);
    expect(won?.title).toBe('CHIẾN THẮNG');
    expect(won?.actions).toEqual(['rematch', 'menu', 'watch']);
    const lost = zoneEndCardView({ winner: 'team-red' } as never, 'team-blue', false);
    expect(lost?.title).toBe('THẤT BẠI');
    expect(lost?.actions).toContain('rematch');
  });

  it('has a card for a draw', () => {
    expect(zoneEndCardView({ draw: true } as never, 'team-blue', false)?.title).toBe('HÒA');
  });

  it('never offers a LAN client a restart of a match it does not own', () => {
    const view = zoneEndCardView({ winner: 'team-blue' } as never, 'team-blue', true);
    expect(view?.actions).toEqual(['menu', 'watch']);
  });

  it('Game shows the card once the zone has a verdict, and tears it down with the match', () => {
    const src = readFileSync(join(__dirname, '../../../src/game/Game.ts'), 'utf8');
    const banner = src.slice(src.indexOf('private drawZoneBanner'));
    expect(banner.slice(0, 900)).toMatch(/zoneEndCard\.sync\(\s*zoneEndCardView\(zone\.result/);
    const destroy = src.slice(src.indexOf('\n  destroy() {'));
    expect(destroy.slice(0, 1500)).toMatch(/zoneEndCard\?\.destroy\(\)/);
  });
});

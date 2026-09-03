/**
 * StateDot contract layer (v0.3.6 P0-C).
 *
 * The indicator must never rely on colour alone (WCAG 1.4.1): the visual dot
 * carries a shape channel via `data-tone`, and by default a visually-hidden
 * (sr-only) text label is rendered for assistive tech. These tests pin the
 * tone mapping, the label vocabulary and the DOM contract.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StateDot, stateTone, stateToneLabel } from '../web/src/components/StateDot';

function render(state: string, props: Partial<React.ComponentProps<typeof StateDot>> = {}) {
  return renderToStaticMarkup(React.createElement(StateDot, { state, ...props }));
}

describe('StateDot', () => {
  describe('stateTone mapping', () => {
    const RUNNING = ['activating', 'live', 'pending', 'queued', 'running', 'streaming'];
    const SUCCESS = ['completed', 'connected', 'done', 'passed', 'ready', 'success'];
    const DANGER = ['closed', 'error', 'failed', 'offline', 'rejected'];
    const WARNING = ['draining', 'replay', 'replay-required', 'skipped', 'timedout', 'warning'];

    it.each(RUNNING)('maps %s to running', state => expect(stateTone(state)).toBe('running'));
    it.each(SUCCESS)('maps %s to success', state => expect(stateTone(state)).toBe('success'));
    it.each(DANGER)('maps %s to danger', state => expect(stateTone(state)).toBe('danger'));
    it.each(WARNING)('maps %s to warning', state => expect(stateTone(state)).toBe('warning'));

    it('falls back to idle for unknown states', () => {
      expect(stateTone('totally-unknown')).toBe('idle');
      expect(stateTone('')).toBe('idle');
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(stateTone('  Running ')).toBe('running');
      expect(stateTone('COMPLETED')).toBe('success');
    });
  });

  describe('stateToneLabel', () => {
    it('returns a human-readable Chinese label for every tone', () => {
      expect(stateToneLabel('danger')).toBe('失败');
      expect(stateToneLabel('idle')).toBe('空闲');
      expect(stateToneLabel('running')).toBe('进行中');
      expect(stateToneLabel('success')).toBe('已完成');
      expect(stateToneLabel('warning')).toBe('部分完成');
    });
  });

  describe('DOM contract', () => {
    it('renders the visual dot with state class, data-tone and aria-hidden', () => {
      const html = render('running');
      expect(html).toContain('class="state-dot state-running"');
      expect(html).toContain('data-tone="running"');
      expect(html).toContain('aria-hidden="true"');
    });

    it('renders a sr-only label by default so colour is never the only channel', () => {
      const html = render('running');
      expect(html).toContain('<span class="sr-only">进行中</span>');
    });

    it('omits the sr-only label when describe is false (adjacent text exists)', () => {
      const html = render('running', { describe: false });
      expect(html).not.toContain('sr-only');
      expect(html).toContain('state-dot');
    });

    it('supports an explicit label override', () => {
      const html = render('failed', { label: '同步中断' });
      expect(html).toContain('<span class="sr-only">同步中断</span>');
    });

    it('appends extra classes to the visual dot', () => {
      const html = render('running', { className: 'rail-status-dot' });
      expect(html).toContain('state-dot state-running rail-status-dot');
    });

    it('keeps the raw state string on the class for styling hooks', () => {
      const html = render('state-failed', { describe: false });
      expect(html).toContain('class="state-dot state-state-failed"');
      // Unknown raw states still collapse to a known tone for shape encoding.
      expect(html).toContain('data-tone="idle"');
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { labelSelectsAwaitingHostUpgrade, scheduleSelectLabelFallback } from 'addons/webGPUPlayer/ui/SelectLabelFallback';

function createPanel(markup: string): HTMLElement {
    const panel = document.createElement('div');
    panel.innerHTML = markup;
    document.body.appendChild(panel);
    return panel;
}

describe('SelectLabelFallback', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    it('adds the label emby-select would create and marks the select so an upgrade adds no second label', () => {
        const panel = createPanel(
            '<div class="selectContainer"><select is="emby-select" id="operator" label="Tone map operator"></select></div>'
        );

        labelSelectsAwaitingHostUpgrade(panel);
        labelSelectsAwaitingHostUpgrade(panel);

        const labels = panel.querySelectorAll('label.selectLabel');
        expect(labels).toHaveLength(1);
        expect(labels[0].textContent).toBe('Tone map operator');
        expect((labels[0] as HTMLLabelElement).htmlFor).toBe('operator');
        expect(labels[0].nextElementSibling?.id).toBe('operator');
        expect(panel.querySelector('select')?.classList.contains('emby-select')).toBe(true);
    });

    it('leaves selects the host already upgraded and plain selects alone', () => {
        const panel = createPanel(
            '<label class="selectLabel">Host label</label><select is="emby-select" class="emby-select" label="Upgraded"></select>'
            + '<select label="Plain"></select>'
        );

        labelSelectsAwaitingHostUpgrade(panel);

        expect(panel.querySelectorAll('label')).toHaveLength(1);
    });

    it('waits one macrotask so registered elements can upgrade first', () => {
        vi.useFakeTimers();
        const panel = createPanel('<div><select is="emby-select" label="Audio output"></select></div>');

        scheduleSelectLabelFallback(panel);
        expect(panel.querySelector('label')).toBeNull();

        vi.runOnlyPendingTimers();
        expect(panel.querySelector('label')?.textContent).toBe('Audio output');
    });
});

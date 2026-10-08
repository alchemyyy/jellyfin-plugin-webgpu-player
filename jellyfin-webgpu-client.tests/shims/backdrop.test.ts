import { describe, expect, it, vi } from 'vitest';

const dashboardMock = vi.hoisted(() => ({
    setBackdropTransparency: vi.fn()
}));

vi.mock('utils/dashboard', () => ({ default: dashboardMock }));

import { setBackdropTransparency, TRANSPARENCY_LEVEL } from 'addons/webGPUPlayer/shims/backdrop';

describe('backdrop shim', () => {
    it('keeps the host transparency levels', () => {
        expect(TRANSPARENCY_LEVEL).toEqual({
            Backdrop: 'backdrop',
            Full: 'full',
            None: 'none'
        });
    });

    it('drives the host backdrop through the Dashboard object', () => {
        setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
        setBackdropTransparency(TRANSPARENCY_LEVEL.None);

        expect(dashboardMock.setBackdropTransparency.mock.calls).toEqual([ [ 'backdrop' ], [ 'none' ] ]);
    });
});

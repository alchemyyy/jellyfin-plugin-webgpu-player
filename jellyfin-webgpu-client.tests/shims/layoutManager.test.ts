import { afterEach, describe, expect, it } from 'vitest';

import layoutManager, { SETTING_KEY } from 'addons/webGPUPlayer/shims/layoutManager';

const LAYOUT_CLASSES = [ 'layout-tv', 'layout-mobile', 'layout-desktop' ];

describe('layoutManager shim', () => {
    afterEach(() => {
        document.documentElement.classList.remove(...LAYOUT_CLASSES);
    });

    it('reflects the layout class the host sets on the document element', () => {
        document.documentElement.classList.add('layout-tv');
        expect([ layoutManager.tv, layoutManager.mobile, layoutManager.desktop ]).toEqual([ true, false, false ]);

        document.documentElement.classList.replace('layout-tv', 'layout-mobile');
        expect([ layoutManager.tv, layoutManager.mobile, layoutManager.desktop ]).toEqual([ false, true, false ]);

        document.documentElement.classList.replace('layout-mobile', 'layout-desktop');
        expect([ layoutManager.tv, layoutManager.mobile, layoutManager.desktop ]).toEqual([ false, false, true ]);
    });

    it('reports no layout before the host applies one', () => {
        expect([ layoutManager.tv, layoutManager.mobile, layoutManager.desktop ]).toEqual([ false, false, false ]);
    });

    it('keeps the host setting key', () => {
        expect(SETTING_KEY).toBe('layout');
    });
});

import type * as HostInputManager from 'scripts/inputManager';

// Bridge for scripts/inputManager: the module namespace comes from the plugin bag

type InputManagerModule = typeof HostInputManager;

let inputManager: InputManagerModule;
let inputManagerDefault: InputManagerModule['default'];

/** Binds the host's inputManager module namespace from the plugin bag. */
export function bindInputManager(value: InputManagerModule): void {
    inputManager = value;
    inputManagerDefault = value.default;
}

/** Records user activity for the host's idle tracking. */
export function notify(): ReturnType<InputManagerModule['notify']> {
    return inputManager.notify();
}

/** Subscribes to host input commands. */
export function on(...parameters: Parameters<InputManagerModule['on']>): ReturnType<InputManagerModule['on']> {
    return inputManager.on(...parameters);
}

/** Unsubscribes from host input commands. */
export function off(...parameters: Parameters<InputManagerModule['off']>): ReturnType<InputManagerModule['off']> {
    return inputManager.off(...parameters);
}

/** Dispatches a host input command. */
export function handleCommand(...parameters: Parameters<InputManagerModule['handleCommand']>): ReturnType<InputManagerModule['handleCommand']> {
    return inputManager.handleCommand(...parameters);
}

export { inputManagerDefault as default };

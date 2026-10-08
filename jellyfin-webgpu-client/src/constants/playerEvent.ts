/** Player events the WebGPU player emits beyond the stock PlayerEvent enum */
export enum WebGPUPlayerEvent {
    // No stock PlaybackManager listens; an unaccepted request falls back to the error retry ladder
    SourceRenegotiationRequired = 'sourcerenegotiationrequired'
}

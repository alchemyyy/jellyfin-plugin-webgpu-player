namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// A playback that left the WebGPU route, or lost its GPU device, as a client reports it.
/// </summary>
/// <param name="Kind">What fell back, one of the kinds <see cref="PlaybackFallbackFunctions"/> names, such as <c>presentation</c>.</param>
/// <param name="Reason">The client's reason code, such as <c>adapter-unavailable</c>.</param>
/// <param name="Detail">A terse detail with the failing value, such as <c>requestAdapter: null</c>; empty when the client has none.</param>
public sealed record PlaybackFallback(string Kind, string Reason, string Detail);

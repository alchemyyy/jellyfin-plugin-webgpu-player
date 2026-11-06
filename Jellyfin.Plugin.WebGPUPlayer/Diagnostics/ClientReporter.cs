namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// The browser and Jellyfin client that sent a diagnostics report, cleaned for the server log; a part the request does not carry reads as unknown.
/// </summary>
/// <param name="Client">The Jellyfin client name, such as <c>Jellyfin Web</c>.</param>
/// <param name="ClientVersion">The Jellyfin client version.</param>
/// <param name="Device">The Jellyfin device name, such as <c>Safari</c>.</param>
/// <param name="UserAgent">The browser's User-Agent.</param>
public sealed record ClientReporter(string Client, string ClientVersion, string Device, string UserAgent);

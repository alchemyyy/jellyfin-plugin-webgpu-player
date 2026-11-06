using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// A capability probe that was in a browser call when a page of the client stopped, as a client reports it.
/// </summary>
/// <param name="Probe">The probe name, such as <c>native-audio</c>.</param>
/// <param name="Steps">The labels of the browser calls the probe had in flight, such as <c>decode aac</c>; empty when the client recorded none.</param>
public sealed record ProbeCrash(string Probe, IReadOnlyList<string> Steps);

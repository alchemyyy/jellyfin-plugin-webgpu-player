using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// The client defaults the server answers with.
/// </summary>
/// <param name="Settings">The default of each client setting an administrator set, by its flat key, as stored.</param>
public sealed record ClientDefaultsDocument(IReadOnlyDictionary<string, JsonElement> Settings);

using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// The client defaults the server stores and answers with.
/// </summary>
/// <param name="Settings">The default of each client setting an administrator set, by its flat key, as stored.</param>
/// <param name="Applied">The revision of each setting an administrator last applied to all clients, by its flat key; a client that has not honored a key's revision drops its user's own choice for it.</param>
public sealed record ClientDefaultsDocument(IReadOnlyDictionary<string, JsonElement> Settings, IReadOnlyDictionary<string, long> Applied);

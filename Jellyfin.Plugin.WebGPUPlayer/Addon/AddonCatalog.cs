using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace Jellyfin.Plugin.WebGPUPlayer.Addon;

/// <summary>
/// The client add-on embedded in this assembly, indexed once on first use.
/// </summary>
public static class AddonCatalog
{
    private static readonly Assembly ResourceAssembly = typeof(AddonCatalog).Assembly;

    // NOTE: Static initializers run in textual order, and the manifest check reads the lookup
    private static readonly FrozenDictionary<string, string> ResourceLookup =
        AssetFunctions.BuildResourceLookup(ResourceAssembly.GetManifestResourceNames());

    private static readonly (string? Entry, string? Problem) Manifest = LoadManifest();

    /// <summary>
    /// Gets the lookup from request-relative asset path to manifest resource name.
    /// </summary>
    public static IReadOnlyDictionary<string, string> Resources => ResourceLookup;

    /// <summary>
    /// Gets the entry module path from the add-on manifest, or <c>null</c> when no usable add-on is embedded.
    /// </summary>
    public static string? Entry => Manifest.Entry;

    /// <summary>
    /// Gets the reason no usable add-on is embedded, or <c>null</c> when <see cref="Entry"/> is set.
    /// </summary>
    public static string? Problem => Manifest.Problem;

    /// <summary>
    /// Opens an embedded add-on file.
    /// </summary>
    /// <param name="relativePath">The normalized request-relative path.</param>
    /// <returns>The resource stream, or <c>null</c> when the file is not embedded.</returns>
    public static Stream? OpenAsset(string relativePath)
    {
        return ResourceLookup.TryGetValue(relativePath, out string? resourceName)
            ? ResourceAssembly.GetManifestResourceStream(resourceName)
            : null;
    }

    private static (string? Entry, string? Problem) LoadManifest()
    {
        using Stream? stream = OpenAsset(AssetFunctions.ManifestFileName);
        if (stream is null)
        {
            return AssetFunctions.ParseAddonManifest(null, ResourceLookup);
        }

        using StreamReader reader = new StreamReader(stream);
        return AssetFunctions.ParseAddonManifest(reader.ReadToEnd(), ResourceLookup);
    }
}

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// The callback argument. File Transformation deserializes <c>{"contents": "..."}</c> into it with Newtonsoft, matching names case-insensitively.
/// </summary>
public sealed class TransformationPayload
{
    /// <summary>
    /// Gets or sets the complete text of the served file.
    /// </summary>
    public string? Contents { get; set; }
}

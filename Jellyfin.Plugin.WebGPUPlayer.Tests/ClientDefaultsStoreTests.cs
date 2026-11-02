using System;
using System.Collections.Generic;
using System.IO;
using Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ClientDefaultsStoreTests : IDisposable
{
    private const long Now = 1_000;

    private readonly DirectoryInfo dataFolder = Directory.CreateTempSubdirectory("webgpu-player-client-defaults-");
    private readonly ManualTimeProvider clock = new ManualTimeProvider(Now);

    public void Dispose()
    {
        dataFolder.Delete(recursive: true);
    }

    [Theory]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": {} """)]
    [InlineData("""{ "version": 3, "settings": { "brightness": 1.25 }, "applied": {} }""")]
    [InlineData("""{ "settings": { "brightness": 1.25 }, "applied": {} }""")]
    [InlineData("""{ "version": 1, "settings": { "brightness": null } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": null }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": ["brightness"] }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": { "brightness": 0 } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": { "brightness": -1 } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": { "brightness": 1.5 } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": { "brightness": "1" } }""")]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 }, "applied": { "tone-map": 1 } }""")]
    public void Open_UnreadableFile_HoldsNoDefaults(string file)
    {
        File.WriteAllText(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName), file);

        ClientDefaultsDocument document = OpenStore().GetDocument();

        Assert.Empty(document.Settings);
        Assert.Empty(document.Applied);
    }

    [Fact]
    public void Open_VersionOneFile_HoldsItsSettingsAndNoAppliedRevisions()
    {
        File.WriteAllText(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName), """{ "version": 1, "settings": { "brightness": 1.25 } }""");

        ClientDefaultsDocument document = OpenStore().GetDocument();

        Assert.Equal(["brightness"], document.Settings.Keys);
        Assert.Empty(document.Applied);
    }

    [Fact]
    public void SetDocument_Applied_HoldsForTheNextStart()
    {
        Assert.Null(OpenStore().SetDocument("""{ "settings": { "brightness": 1.25 }, "apply": ["brightness", "contrast"] }"""u8.ToArray()).Problem);

        ClientDefaultsDocument reopened = OpenStore().GetDocument();

        Assert.Equal(1.25, reopened.Settings["brightness"].GetDouble());
        Assert.Equal(new Dictionary<string, long> { ["brightness"] = Now, ["contrast"] = Now }, reopened.Applied);
    }

    [Fact]
    public void SetDocument_ApplyAfterTheFileIsDeleted_StaysAtOrAfterTheCurrentTime()
    {
        ClientDefaultsStore store = OpenStore();
        Assert.Null(store.SetDocument("""{ "settings": {}, "apply": ["brightness"] }"""u8.ToArray()).Problem);
        File.Delete(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName));
        clock.UnixTimeMilliseconds = Now + 500;

        ClientDefaultsDocument? document = OpenStore().SetDocument("""{ "settings": {}, "apply": ["brightness"] }"""u8.ToArray()).Document;

        Assert.Equal(Now + 500, document?.Applied["brightness"]);
    }

    [Fact]
    public void SetDocument_RefusedWrite_KeepsTheDefaults()
    {
        ClientDefaultsStore store = OpenStore();
        Assert.Null(store.SetDocument("""{ "settings": { "brightness": 1.25 }, "apply": ["brightness"] }"""u8.ToArray()).Problem);
        // A folder in the file's place refuses the write
        File.Delete(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName));
        Directory.CreateDirectory(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName));

        ClientDefaultsProblem? problem = store.SetDocument("""{ "settings": { "contrast": 1.5 }, "apply": ["brightness", "contrast"] }"""u8.ToArray()).Problem;

        Assert.Equal(ClientDefaultsProblem.WriteFailedCode, problem?.Code);
        Assert.Equal(["brightness"], store.GetDocument().Settings.Keys);
        Assert.Equal(new Dictionary<string, long> { ["brightness"] = Now }, store.GetDocument().Applied);
    }

    private ClientDefaultsStore OpenStore()
    {
        return new ClientDefaultsStore(dataFolder.FullName, NullLogger<ClientDefaultsStore>.Instance, clock);
    }
}

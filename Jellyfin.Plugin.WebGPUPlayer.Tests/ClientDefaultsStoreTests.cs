using System;
using System.IO;
using Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ClientDefaultsStoreTests : IDisposable
{
    private readonly DirectoryInfo dataFolder = Directory.CreateTempSubdirectory("webgpu-player-client-defaults-");

    public void Dispose()
    {
        dataFolder.Delete(recursive: true);
    }

    [Theory]
    [InlineData("""{ "version": 1, "settings": { "brightness": 1.25 """)]
    [InlineData("""{ "version": 2, "settings": { "brightness": 1.25 } }""")]
    [InlineData("""{ "settings": { "brightness": 1.25 } }""")]
    [InlineData("""{ "version": 1, "settings": { "brightness": null } }""")]
    public void Open_UnreadableFile_HoldsNoDefaults(string file)
    {
        File.WriteAllText(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName), file);

        ClientDefaultsStore store = new ClientDefaultsStore(dataFolder.FullName, NullLogger<ClientDefaultsStore>.Instance);

        Assert.Empty(store.GetSettings());
    }

    [Fact]
    public void SetDocument_RefusedWrite_KeepsTheDefaults()
    {
        ClientDefaultsStore store = new ClientDefaultsStore(dataFolder.FullName, NullLogger<ClientDefaultsStore>.Instance);
        Assert.Null(store.SetDocument("""{ "settings": { "brightness": 1.25 } }"""u8.ToArray()).Problem);
        // A folder in the file's place refuses the write
        File.Delete(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName));
        Directory.CreateDirectory(Path.Combine(dataFolder.FullName, ClientDefaultsStore.FileName));

        ClientDefaultsProblem? problem = store.SetDocument("""{ "settings": { "contrast": 1.5 } }"""u8.ToArray()).Problem;

        Assert.Equal(ClientDefaultsProblem.WriteFailedCode, problem?.Code);
        Assert.Equal(["brightness"], store.GetSettings().Keys);
    }
}

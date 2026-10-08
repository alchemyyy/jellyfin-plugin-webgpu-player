using System;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class PluginTests
{
    [Fact]
    public void CreateInstance_LikeTheServer_RecordsTheAssemblyPathAndVersion()
    {
        Assembly testedAssembly = typeof(Plugin).Assembly;
        ServiceCollection services = new ServiceCollection();
        services.AddSingleton<IApplicationPaths>(new TestApplicationPaths(Path.GetTempPath()));
        services.AddSingleton<IXmlSerializer>(new UnusedXmlSerializer());
        using ServiceProvider serviceProvider = services.BuildServiceProvider();

        // The server loads each plugin into its own load context; the isolated copy also leaves Plugin.Instance unset for the other tests
        AssemblyLoadContext loadContext = new AssemblyLoadContext(nameof(PluginTests), isCollectible: true);
        try
        {
            Type pluginType = loadContext.LoadFromAssemblyPath(testedAssembly.Location).GetType(typeof(Plugin).FullName!, throwOnError: true)!;
            IPlugin plugin = (IPlugin)ActivatorUtilities.CreateInstance(serviceProvider, pluginType);

            // The server dereferences both while creating the plugin, and the dashboard's plugin list reads the info
            Assert.Equal(testedAssembly.Location, plugin.AssemblyFilePath);
            Assert.Equal(testedAssembly.GetName().Version, plugin.Version);
            PluginInfo pluginInfo = plugin.GetPluginInfo();
            Assert.Equal(plugin.Version, pluginInfo.Version);
            Assert.Equal(plugin.Id, pluginInfo.Id);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    // Every directory resolves to one folder; creating the plugin only reads PluginsPath
    private sealed class TestApplicationPaths(string rootPath) : IApplicationPaths
    {
        public string ProgramDataPath => rootPath;

        public string WebPath => rootPath;

        public string ProgramSystemPath => rootPath;

        public string DataPath => rootPath;

        public string ImageCachePath => rootPath;

        public string PluginsPath => rootPath;

        public string PluginConfigurationsPath => rootPath;

        public string LogDirectoryPath => rootPath;

        public string ConfigurationDirectoryPath => rootPath;

        public string SystemConfigurationFilePath => rootPath;

        public string CachePath => rootPath;

        public string TempDirectory => rootPath;

        public string VirtualDataPath => rootPath;

        public string TrickplayPath => rootPath;

        public string BackupPath => rootPath;

        public void MakeSanityCheckOrThrow()
        {
        }

        public void CreateAndCheckMarker(string path, string markerName, bool recursive = false)
        {
        }
    }

    // Only configuration access serializes, and creating the plugin never reads its configuration
    private sealed class UnusedXmlSerializer : IXmlSerializer
    {
        public object DeserializeFromStream(Type type, Stream stream) => throw new NotSupportedException();

        public void SerializeToStream(object obj, Stream stream) => throw new NotSupportedException();

        public void SerializeToFile(object obj, string file) => throw new NotSupportedException();

        public object DeserializeFromFile(Type type, string file) => throw new NotSupportedException();

        public object DeserializeFromBytes(Type type, byte[] buffer) => throw new NotSupportedException();
    }
}

using System;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class FileTransformationTests
{
    private const string TransformationId = "fedb474b-4b31-47cb-881c-7d9d0efa0e5c";
    private const string Page = "<html><head><title>x</title></head><body></body></html>";

    [Fact]
    public void BuildRegistrationJSON_CarriesTheExactKeyAndCallbackIdentity()
    {
        string registrationJSON = FileTransformationFunctions.BuildRegistrationJSON(
            new Guid(TransformationId),
            FileTransformationRegistrar.IndexHTMLFileName,
            typeof(TransformationCallbacks),
            nameof(TransformationCallbacks.TransformIndexHTML));

        JsonObject registration = JsonNode.Parse(registrationJSON)!.AsObject();
        Assert.Equal(5, registration.Count);
        Assert.Equal(TransformationId, (string?)registration["id"]);
        Assert.Equal("index.html", (string?)registration["fileNamePattern"]);
        Assert.Equal(typeof(TransformationCallbacks).Assembly.FullName, (string?)registration["callbackAssembly"]);
        Assert.Equal("Jellyfin.Plugin.WebGPUPlayer.Transformations.TransformationCallbacks", (string?)registration["callbackClass"]);
        Assert.Equal("TransformIndexHTML", (string?)registration["callbackMethod"]);
    }

    [Fact]
    public void CreatePayload_ParsesIntoTheRegisterMethodParameterType()
    {
        MethodInfo registerMethod = typeof(FakePluginInterface).GetMethod(nameof(FakePluginInterface.RegisterTransformation))!;
        string registrationJSON = FileTransformationFunctions.BuildRegistrationJSON(
            new Guid(TransformationId),
            FileTransformationRegistrar.ConfigJSONFileName,
            typeof(TransformationCallbacks),
            nameof(TransformationCallbacks.TransformConfigJSON));

        object payload = FileTransformationFunctions.CreatePayload(registerMethod, registrationJSON);
        registerMethod.Invoke(null, [payload]);

        // File Transformation reads the payload with Newtonsoft ToObject, case-insensitively
        RegistrationMirror registration = Assert.IsType<JObject>(payload).ToObject<RegistrationMirror>()!;
        Assert.Equal(new Guid(TransformationId), registration.Id);
        Assert.Equal("config.json", registration.FileNamePattern);
        Assert.Equal(nameof(TransformationCallbacks.TransformConfigJSON), registration.CallbackMethod);
    }

    [Theory]
    [InlineData(nameof(FakePluginInterface.TakesTwoParameters))]
    [InlineData(nameof(FakePluginInterface.TakesUnparsablePayload))]
    public void CreatePayload_WithoutOneParsablePayload_Throws(string methodName)
    {
        MethodInfo registerMethod = typeof(FakePluginInterface).GetMethod(methodName)!;

        Assert.Throws<InvalidOperationException>(() => FileTransformationFunctions.CreatePayload(registerMethod, "{}"));
    }

    [Fact]
    public void FindRegisterMethod_FindsPluginInterfaceInAFileTransformationAssembly()
    {
        AssemblyBuilder fileTransformation = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("Jellyfin.Plugin.FileTransformation"), AssemblyBuilderAccess.RunAndCollect);
        TypeBuilder pluginInterface = fileTransformation
            .DefineDynamicModule("Jellyfin.Plugin.FileTransformation")
            .DefineType(FileTransformationFunctions.PluginInterfaceTypeName, TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
        pluginInterface
            .DefineMethod(FileTransformationFunctions.RegisterMethodName, MethodAttributes.Public | MethodAttributes.Static, typeof(void), [typeof(JObject)])
            .GetILGenerator()
            .Emit(OpCodes.Ret);
        pluginInterface.CreateType();

        MethodInfo? registerMethod = FileTransformationFunctions.FindRegisterMethod([typeof(FileTransformationTests).Assembly, fileTransformation]);

        Assert.NotNull(registerMethod);
        Assert.Equal(typeof(JObject), Assert.Single(registerMethod.GetParameters()).ParameterType);
    }

    [Fact]
    public void FindRegisterMethod_WithoutFileTransformation_ReturnsNull()
    {
        Assert.Null(FileTransformationFunctions.FindRegisterMethod([typeof(Plugin).Assembly, typeof(FileTransformationTests).Assembly]));
    }

    [Theory]
    [InlineData(nameof(TransformationCallbacks.TransformIndexHTML))]
    [InlineData(nameof(TransformationCallbacks.TransformConfigJSON))]
    public void RegisteredCallback_ResolvesAndRunsTheWayFileTransformationInvokesIt(string callbackMethod)
    {
        string registrationJSON = FileTransformationFunctions.BuildRegistrationJSON(Guid.NewGuid(), "x", typeof(TransformationCallbacks), callbackMethod);
        RegistrationMirror registration = JObject.Parse(registrationJSON).ToObject<RegistrationMirror>()!;

        // Mirrors TransformationHelper tier 1 in File Transformation
        Assembly? assembly = AssemblyLoadContext.All
            .FirstOrDefault(context => context.Assemblies.Select(candidate => candidate.FullName).Contains(registration.CallbackAssembly))?
            .Assemblies.FirstOrDefault(candidate => candidate.FullName == registration.CallbackAssembly);
        MethodInfo? method = assembly?.GetType(registration.CallbackClass!)?.GetMethod(registration.CallbackMethod!);
        Assert.NotNull(method);
        object? argument = new JObject { { "contents", Page } }.ToObject(method.GetParameters()[0].ParameterType);
        string? result = method.Invoke(null, [argument]) as string;

        // No plugin instance exists in tests, and the page is not JSON, so both callbacks keep the text
        Assert.Equal(Page, result);
    }

    [Fact]
    public void TransformIndexHTML_WithoutPluginInstance_ReturnsInputUnchanged()
    {
        Assert.Same(Page, TransformationCallbacks.TransformIndexHTML(new TransformationPayload { Contents = Page }));
        Assert.Null(TransformationCallbacks.TransformIndexHTML(new TransformationPayload()));
        Assert.Null(TransformationCallbacks.TransformIndexHTML(null));
    }

    [Fact]
    public void TransformConfigJSON_WithoutPluginInstance_ReturnsInputUnchanged()
    {
        const string Config = "{\"plugins\":[\"htmlVideoPlayer/plugin\"]}";

        // index.html would not get the window factory either, so listing the plugin would only fail its load
        Assert.Same(Config, TransformationCallbacks.TransformConfigJSON(new TransformationPayload { Contents = Config }));
        Assert.Null(TransformationCallbacks.TransformConfigJSON(new TransformationPayload()));
        Assert.Null(TransformationCallbacks.TransformConfigJSON(null));
    }

    [Fact]
    public async Task StartAsync_SelectsFileTransformationOnlyWhenItIsLoaded()
    {
        FileTransformationRegistrar registrar = new FileTransformationRegistrar(NullLogger<FileTransformationRegistrar>.Instance);

        await registrar.StartAsync(TestContext.Current.CancellationToken);
        await registrar.StopAsync(TestContext.Current.CancellationToken);

        // NOTE: FindRegisterMethod_FindsPluginInterfaceInAFileTransformationAssembly may already have loaded a fake
        // File Transformation, which accepts both registrations; without it the plugin's own middleware is chosen
        bool fileTransformationLoaded = FileTransformationFunctions.FindRegisterMethod(AssemblyLoadContext.All.SelectMany(context => context.Assemblies)) is not null;
        WebClientRewriteMode expected = (AddonCatalog.Entry is not null, fileTransformationLoaded) switch
        {
            (false, _) => WebClientRewriteMode.Disabled,
            (true, true) => WebClientRewriteMode.FileTransformation,
            (true, false) => WebClientRewriteMode.Middleware,
        };
        Assert.Equal(expected, WebClientRewriteState.Mode);
    }

    [Fact]
    public void RegisterServices_AddsTheRegistrarAndTheFallbackMiddleware()
    {
        ServiceCollection services = new ServiceCollection();

        new PluginServiceRegistrator().RegisterServices(services, null!);

        Assert.Contains(services, descriptor => descriptor.ServiceType == typeof(IHostedService) && descriptor.ImplementationType == typeof(FileTransformationRegistrar));
        Assert.Contains(services, descriptor => descriptor.ServiceType == typeof(IStartupFilter) && descriptor.ImplementationType == typeof(WebClientRewriteStartupFilter));
    }

    [Fact]
    public void FindRemoveMethod_FindsTheRemovalBesideRegistration()
    {
        MethodInfo registerMethod = typeof(FakePluginInterface).GetMethod(nameof(FakePluginInterface.RegisterTransformation))!;

        MethodInfo? removeMethod = FileTransformationFunctions.FindRemoveMethod(registerMethod);

        Assert.NotNull(removeMethod);
        Assert.Equal(typeof(Guid), Assert.Single(removeMethod.GetParameters()).ParameterType);
    }

    [Fact]
    public void FindRemoveMethod_WithoutRemoval_ReturnsNull()
    {
        MethodInfo registerMethod = typeof(FakePluginInterfaceWithoutRemoval).GetMethod(nameof(FakePluginInterfaceWithoutRemoval.RegisterTransformation))!;

        Assert.Null(FileTransformationFunctions.FindRemoveMethod(registerMethod));
    }

    // Stands in for File Transformation's PluginInterface, whose payload is a Newtonsoft JObject
    private static class FakePluginInterface
    {
        public static JObject? LastPayload { get; private set; }

        public static void RegisterTransformation(JObject payload)
        {
            LastPayload = payload;
        }

        public static void TakesTwoParameters(JObject payload, JObject other)
        {
            LastPayload = payload ?? other;
        }

        public static void TakesUnparsablePayload(object payload)
        {
            LastPayload = payload as JObject;
        }

        public static void RemoveTransformation(Guid id)
        {
            LastPayload = new JObject { { "removed", id } };
        }
    }

    // Stands in for a File Transformation version before 3.0, which had no removal
    private static class FakePluginInterfaceWithoutRemoval
    {
        public static JObject? LastPayload { get; private set; }

        public static void RegisterTransformation(JObject payload)
        {
            LastPayload = payload;
        }
    }

    // Mirrors File Transformation's TransformationRegistrationPayload
    private sealed class RegistrationMirror
    {
        public Guid Id { get; set; }

        public string? FileNamePattern { get; set; }

        public string? CallbackAssembly { get; set; }

        public string? CallbackClass { get; set; }

        public string? CallbackMethod { get; set; }
    }
}

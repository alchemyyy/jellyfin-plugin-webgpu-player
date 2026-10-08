using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Stateless reflection glue for the File Transformation plugin, which this plugin never references at compile time.
/// </summary>
public static class FileTransformationFunctions
{
    /// <summary>
    /// The fragment that identifies the File Transformation assembly by full name.
    /// </summary>
    public const string AssemblyNameFragment = ".FileTransformation";

    /// <summary>
    /// The File Transformation type that exposes registration.
    /// </summary>
    public const string PluginInterfaceTypeName = "Jellyfin.Plugin.FileTransformation.PluginInterface";

    /// <summary>
    /// The static registration method on <see cref="PluginInterfaceTypeName"/>.
    /// </summary>
    public const string RegisterMethodName = "RegisterTransformation";

    /// <summary>
    /// The static removal method on <see cref="PluginInterfaceTypeName"/>, available since File Transformation 3.0.
    /// </summary>
    public const string RemoveMethodName = "RemoveTransformation";

    private const string ParseMethodName = "Parse";
    private const string GuidFormat = "D";

    private static readonly Type[] ParseParameterTypes = [typeof(string)];
    private static readonly Type[] RemoveParameterTypes = [typeof(Guid)];

    /// <summary>
    /// Finds the File Transformation registration method among loaded assemblies.
    /// </summary>
    /// <param name="assemblies">The assemblies of every load context.</param>
    /// <returns>The public static registration method, or <c>null</c> when File Transformation is not loaded.</returns>
    public static MethodInfo? FindRegisterMethod(IEnumerable<Assembly> assemblies)
    {
        foreach (Assembly assembly in assemblies)
        {
            if (!(assembly.FullName?.Contains(AssemblyNameFragment, StringComparison.Ordinal) ?? false))
            {
                continue;
            }

            MethodInfo? registerMethod = assembly.GetType(PluginInterfaceTypeName)?.GetMethod(RegisterMethodName, BindingFlags.Public | BindingFlags.Static);
            if (registerMethod is not null)
            {
                return registerMethod;
            }
        }

        return null;
    }

    /// <summary>
    /// Finds the File Transformation removal method beside its registration method.
    /// </summary>
    /// <param name="registerMethod">The registration method.</param>
    /// <returns>The public static removal method, or <c>null</c> when this File Transformation version has none.</returns>
    public static MethodInfo? FindRemoveMethod(MethodInfo registerMethod)
    {
        return registerMethod.DeclaringType?.GetMethod(RemoveMethodName, BindingFlags.Public | BindingFlags.Static, RemoveParameterTypes);
    }

    /// <summary>
    /// Builds the registration JSON for a callback that File Transformation invokes through reflection.
    /// </summary>
    /// <param name="id">The constant identifier of the transformation.</param>
    /// <param name="fileNamePattern">The exact file key below <c>/web/</c>.</param>
    /// <param name="callbackType">The type that declares the callback.</param>
    /// <param name="callbackMethod">The public static callback name.</param>
    /// <returns>The registration as a JSON object.</returns>
    public static string BuildRegistrationJSON(Guid id, string fileNamePattern, Type callbackType, string callbackMethod)
    {
        JsonObject registration = new JsonObject
        {
            ["id"] = id.ToString(GuidFormat, CultureInfo.InvariantCulture),
            ["fileNamePattern"] = fileNamePattern,
            ["callbackAssembly"] = callbackType.Assembly.FullName,
            ["callbackClass"] = callbackType.FullName,
            ["callbackMethod"] = callbackMethod,
        };

        return registration.ToJsonString();
    }

    /// <summary>
    /// Creates the registration argument as the payload type that the registration method declares.
    /// The type is Newtonsoft's JObject from File Transformation's load context, so it is built through that type's static <c>Parse(string)</c> rather than a compile-time reference.
    /// </summary>
    /// <param name="registerMethod">The registration method.</param>
    /// <param name="registrationJSON">The registration JSON.</param>
    /// <returns>The parsed payload.</returns>
    /// <exception cref="InvalidOperationException">The method does not take a single payload with a static <c>Parse(string)</c>.</exception>
    public static object CreatePayload(MethodInfo registerMethod, string registrationJSON)
    {
        ParameterInfo[] parameters = registerMethod.GetParameters();
        if (parameters.Length != 1)
        {
            throw new InvalidOperationException(RegisterMethodName + " does not take exactly one payload parameter");
        }

        Type payloadType = parameters[0].ParameterType;
        MethodInfo? parseMethod = payloadType.GetMethod(ParseMethodName, BindingFlags.Public | BindingFlags.Static, ParseParameterTypes);
        if (parseMethod is null || !payloadType.IsAssignableFrom(parseMethod.ReturnType))
        {
            throw new InvalidOperationException(payloadType.FullName + " has no static Parse(string) that returns it");
        }

        return parseMethod.Invoke(null, [registrationJSON])
            ?? throw new InvalidOperationException(payloadType.FullName + ".Parse returned null");
    }
}

// WGSL shader pass sources the presentation settings suites store, add, and show

export const SATURATION_PASS_NAME = 'Saturation';
export const SATURATION_PARAMETER_NAME = 'saturation';
// The range and default SATURATION_PASS_SOURCE declares for its parameter
export const SATURATION_PARAMETER_MINIMUM = 0;
export const SATURATION_PARAMETER_MAXIMUM = 2;
export const SATURATION_PARAMETER_DEFAULT = 1.2;
/** A saturation a user stored, inside the declared range. */
export const STORED_SATURATION = 0.5;

/** A color pass that scales chroma by one f32 parameter. */
export const SATURATION_PASS_SOURCE = [
    `//! name: ${SATURATION_PASS_NAME}`,
    '//! shape: color',
    '//! hook: OUTPUT',
    '//! domain: display',
    `//! param ${SATURATION_PARAMETER_NAME}: f32 = ${SATURATION_PARAMETER_DEFAULT} in [${SATURATION_PARAMETER_MINIMUM}, ${SATURATION_PARAMETER_MAXIMUM}]`,
    '',
    'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    '    let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));',
    `    return vec4f(mix(vec3f(luma), color.rgb, parameters.${SATURATION_PARAMETER_NAME}), color.a);`,
    '}',
    ''
].join('\n');

export const INVERT_PASS_NAME = 'Invert';

/** A color pass without parameters. */
export const INVERT_PASS_SOURCE = [
    `//! name: ${INVERT_PASS_NAME}`,
    '//! shape: color',
    '//! hook: OUTPUT',
    '//! domain: display',
    '',
    'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    '    return vec4f(vec3f(1.0) - color.rgb, color.a);',
    '}',
    ''
].join('\n');

/** The name MISSING_SHAPE_PASS_SOURCE declares before the check that fails. */
export const MISSING_SHAPE_PASS_NAME = 'Unshaped';

/** A pass whose header declares no shape, which the engine's manifest parser rejects. */
export const MISSING_SHAPE_PASS_SOURCE = [
    `//! name: ${MISSING_SHAPE_PASS_NAME}`,
    '//! hook: OUTPUT',
    '',
    'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    '    return color;',
    '}',
    ''
].join('\n');

/** Whitespace only, which no stored pass may hold. */
export const BLANK_PASS_SOURCE = ' \n\t\n';

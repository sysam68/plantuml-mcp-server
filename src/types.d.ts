declare module 'content-type' {
  interface ParsedMediaType {
    type: string;
    parameters: Record<string, string>;
  }

  export function parse(input: string): ParsedMediaType;
  export function format(mediaType: ParsedMediaType): string;
}

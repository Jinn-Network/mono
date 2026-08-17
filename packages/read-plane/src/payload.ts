export interface ParseableSchema<T> {
  parse(input: unknown): T;
}

export class SchemaPayload<T> {
  constructor(private readonly schema: ParseableSchema<T>) {}

  parse(input: unknown): T {
    return this.schema.parse(input);
  }

  json(value: T): T {
    return this.schema.parse(value);
  }
}

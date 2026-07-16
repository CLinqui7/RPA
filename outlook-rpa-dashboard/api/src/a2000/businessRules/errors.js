export class A2000PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'A2000PolicyError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

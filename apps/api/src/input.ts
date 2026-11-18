import { BadRequestException } from '@nestjs/common';

export function objectInput(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Expected a JSON object');
  }
  return body as Record<string, unknown>;
}

export function textInput(value: unknown, field: string, max: number, allowEmpty = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (typeof value !== 'string' || text.length > max || (!allowEmpty && !text)) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return text;
}

export function emailInput(value: unknown) {
  const email = textInput(value, 'email', 255).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestException('Invalid email');
  }
  return email;
}

export function passwordInput(value: unknown, min = 12) {
  if (typeof value !== 'string' || value.length < min || value.length > 256) {
    throw new BadRequestException('Invalid password length');
  }
  return value;
}

#!/usr/bin/env node

/**
 * Точка входа CLI.
 *
 * Пока только каркас: команды прогона появятся в сессии 4 вместе с
 * обязательным allowlist хостов и флагом --unsafe-methods. Половинчатую
 * поверхность безопасности здесь заводить нельзя — либо она работает целиком,
 * либо её нет.
 */

import { createRequire } from "node:module";
import { Command } from "commander";

// Версия читается из package.json, а не дублируется константой: разошедшись,
// дубликат заставил бы CLI врать о собственной версии в отчётах о прогонах.
// Путь считается от dist/cli.js, package.json всегда лежит в корне пакета.
const requireFromHere = createRequire(import.meta.url);
const { version } = requireFromHere("../package.json") as { readonly version: string };

const program = new Command();

program
  .name("barbican")
  .description("Проверка RBAC и изоляции тенантов в API мультитенантных платформ")
  .version(version);

program.parse();

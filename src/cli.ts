#!/usr/bin/env node

/**
 * Точка входа CLI.
 *
 * Пока только каркас: команды прогона появятся в сессии 4 вместе с
 * обязательным allowlist хостов и флагом --unsafe-methods. Половинчатую
 * поверхность безопасности здесь заводить нельзя — либо она работает целиком,
 * либо её нет.
 */

import { Command } from "commander";

// TODO(сессия 4): брать из package.json, а не дублировать. См. tasks.md.
const VERSION = "0.0.0";

const program = new Command();

program
  .name("barbican")
  .description("Проверка RBAC и изоляции тенантов в API мультитенантных платформ")
  .version(VERSION);

program.parse();

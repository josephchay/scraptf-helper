// 0.7.3: the installer ships the licence notices that NOTICE lists. The ported MIT code (node-tf2-sku in
// src/shared/sku.ts, node-tf2-schema's getName in src/service/connectors/schemaNames.ts) needs its copyright
// and permission notice in every copy, and the NetroScript-derived code needs the Apache-2.0 text (4(a)).
// esbuild drops the ported files' header comments, so the notices travel as files next to the app instead.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const at = (rel: string) => new URL(`../../${rel}`, import.meta.url);
const root = (rel: string) => readFileSync(at(rel), 'utf8');

/**
 * The npm packages the renderer bundle imports at runtime ('import type' is erased): '@scope/name', else the
 * first path segment of a bare specifier, so 'react-dom/client' is react-dom.
 */
function bundledImports(): Set<string> {
  const names = new Set<string>();
  for (const dir of ['src/renderer', 'src/shared']) {
    for (const rel of readdirSync(at(dir), { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(rel)) continue;
      const src = root(`${dir}/${rel.replace(/\\/g, '/')}`);
      for (const m of src.matchAll(/\b(?:import|export)\s+(?!type\b)(?:[^;'"]*?\bfrom\s+)?(['"])([^.'"/][^'"]*)\1/g)) {
        const spec = m[2]!;
        names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    }
  }
  return names;
}

/** The top-level extraFiles block of electron-builder.yml, up to the next top-level key. */
function extraFilesBlock(yml: string): string {
  const m = /^extraFiles:\r?\n((?:[ \t]+.*\r?\n|\r?\n)*)/m.exec(yml);
  return m ? m[1]! : '';
}

/** 0.7.3: one line ending, whatever core.autocrlf wrote on checkout (git stores the YAML with LF). */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** The fuse that encrypts every on-disk cookie store, inside the top-level electronFuses block. */
const COOKIE_FUSE = /^electronFuses:\n(?: {2}\w+: \w+\n)*? {2}enableCookieEncryption: true$/m;

describe('licence notices in the packaged app', () => {
  const yml = lf(root('electron-builder.yml'));

  it('copies NOTICE and the Apache-2.0 text into the install folder', () => {
    const block = extraFilesBlock(yml);
    expect(block).toMatch(/- from: NOTICE\r?\n\s+to: NOTICE\.txt/);
    expect(block).toMatch(/- from: reference\/scrap\.tf-item-information-master\/LICENSE\r?\n\s+to: LICENSE\.Apache-2\.0\.txt/);
  });

  it('names only sources that exist: electron-builder only warns about a missing one and ships without it', () => {
    const froms = [...extraFilesBlock(yml).matchAll(/from: (\S+)/g)].map((m) => m[1]!);
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const from of froms) expect(existsSync(at(from)), from).toBe(true);
    const apache = root('reference/scrap.tf-item-information-master/LICENSE');
    expect(apache).toContain('Apache License');
    expect(apache).toContain('Version 2.0, January 2004');
  });

  it('keeps the MIT notices in NOTICE and says where an install has the Apache text', () => {
    const notice = root('NOTICE');
    expect(notice).toContain('Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen');
    expect(notice).toContain('node-tf2-schema');
    // 0.7.3: node-tf2-schema's line is the one the port's header records, not a looser "and contributors" form.
    expect(notice).toMatch(/node-tf2-schema — https:\/\/github\.com\/TF2Autobot\/node-tf2-schema\r?\nMIT License\. Copyright \(c\) 2020 IdiNium\/Nicklas Marc Pedersen\./);
    expect(notice).not.toContain('and contributors');
    expect(notice).toContain('Permission is hereby granted, free of charge');
    expect(notice).toContain('The above copyright notice and this permission notice shall be included');
    expect(notice).toContain('LICENSE.Apache-2.0.txt');
  });

  it('keeps the notice of every package Vite inlines into the renderer bundle (React, React DOM, Scheduler)', () => {
    // 0.7.3: a devDependency the renderer imports is inlined by Vite with its licence header dropped, and
    // electron-builder ships no copy of its package (nor its LICENSE) in app.asar, so NOTICE must carry it.
    const pkg = JSON.parse(root('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};
    // @vitejs/plugin-react/preamble (main.tsx) is the plugin's virtual module, empty in production builds.
    const virtual = new Set(['@vitejs/plugin-react']);
    const inlined = [...bundledImports()].filter((n) => n in devDeps && !(n in deps) && !virtual.has(n));
    expect(inlined).toEqual(expect.arrayContaining(['react', 'react-dom']));
    if (inlined.includes('react-dom')) inlined.push('scheduler');
    const notice = root('NOTICE');
    const named: Record<string, RegExp> = { react: /\bReact\b/, 'react-dom': /React DOM|react-dom/i, scheduler: /\bScheduler\b/i };
    for (const name of inlined) expect(notice, name).toMatch(named[name] ?? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    expect(notice).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
    expect(notice).toContain('applies to the MIT-licensed works above');
    // 0.7.3: Vite's own modulepreload polyfill would be inlined too, so the build turns it off.
    expect(root('vite.config.ts')).toMatch(/^\s*modulePreload:\s*\{\s*polyfill:\s*false\s*\}/m);
  });

  it('credits both MIT ports with their copyright on the About page and points to the shipped files', () => {
    const about = root('src/renderer/pages/AboutPage.tsx');
    expect(about).toContain('node-tf2-schema');
    expect(about).toContain('IdiNium/Nicklas Marc Pedersen');
    // 0.7.3: the tf2-sku line above also carries that name, so pin the node-tf2-schema line itself.
    expect(about).toContain('Item names use a port of getName from node-tf2-schema, MIT License, Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen.</li>');
    expect(about).not.toContain('and contributors');
    expect(about).toContain('NOTICE.txt');
    expect(about).toContain('LICENSE.Apache-2.0.txt');
    expect(about).not.toContain('SKU handling is a port of @tf2autobot/tf2-sku (MIT).</li>');
  });

  it('gives node-tf2-schema the copyright its port header records, so the header, NOTICE and About cannot drift apart', () => {
    expect(root('src/service/connectors/schemaNames.ts')).toMatch(
      /port of Schema#getName from node-tf2-schema[\s\S]{0,200}?Copyright \(c\) 2020 IdiNium\/Nicklas Marc Pedersen/,
    );
  });

  it('leaves the electronFuses block whole', () => {
    expect(yml).toMatch(COOKIE_FUSE);
  });

  it('reads electron-builder.yml the same when a checkout wrote CRLF, and still needs the fuse on', () => {
    const crlf = yml.replace(/\n/g, '\r\n');
    expect(crlf).not.toMatch(COOKIE_FUSE);
    expect(lf(crlf)).toMatch(COOKIE_FUSE);
    expect(extraFilesBlock(lf(crlf))).toBe(extraFilesBlock(yml));
    expect(lf(crlf.replace('enableCookieEncryption: true', 'enableCookieEncryption: false'))).not.toMatch(COOKIE_FUSE);
  });
});

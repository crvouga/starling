import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',fullyParallel:false,workers:1,timeout:180000,globalSetup:'./tests/browser/setup.ts',use:{viewport:{width:1440,height:900},video:'on',screenshot:'only-on-failure',trace:'retain-on-failure'}});

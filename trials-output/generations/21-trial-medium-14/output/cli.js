#!/usr/bin/env node

// A simple CLI that takes one argument and prints "Hello, <arg>"

const args = process.argv.slice(2);

if (args.length !== 1) {
    console.error('Usage: cli <name>');
    process.exit(1);
}

const name = args[0];
console.log(`Hello, ${name}`);
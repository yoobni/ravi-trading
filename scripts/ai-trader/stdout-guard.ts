/** MCP stdio 는 stdout 이 프로토콜 채널이다 — 다른 모듈(dotenv·upbit-client)의 console.log 를 stderr 로 돌린다. 반드시 첫 import. */
process.env.DOTENV_CONFIG_QUIET = 'true';
console.log = console.error;
console.info = console.error;
console.warn = console.error;
export {};

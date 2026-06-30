# 알고리즘

전략을 **적용중(active)** 과 **보관(archive)** 으로 구분.

```
algorithms/
  active/     ← 현재 paper 운영 중인 전략 명세
  archive/    ← 탐색했으나 미채택 (보관)
    specs/      옛 일봉 전략 스펙 + 미채택 설계문서
    research/   백테스트 스크립트(r1~r49) + 헬퍼
```

---

## active — 적용중 (각 1,000만 KRW 독립 paper)

| 전략 | 룰 요약 | 명세 | MDD(4Y bt) |
|---|---|---|---|
| **FUNDING_F1F2_50** | BTC daily, funding 극단 역추세 → LONG. TP+8/SL-5/MAX10d, 자본50% | (룰: `src/lib/paper-funding-strategy.ts`) | — |
| **F6 NEW_HIGH 42** | 4h, 7일 신고가 돌파+follow-through+volZ≥0.5. TP+5/SL-2/MAX14d | [active/PAPER_F6_DESIGN.md](active/PAPER_F6_DESIGN.md) | 27% |
| **F6_v2 (TP_OPT)** | F6 동일 신호, exit TP+7/SL-2.5 | [active/PAPER_F6_V2_DESIGN.md](active/PAPER_F6_V2_DESIGN.md) | 27% |
| **F6_v3 (CONFIRM)** | F6 + 거짓돌파 확인봉 확정. TP+10/SL-3, 25%×4 | [active/PAPER_F6_V3_DESIGN.md](active/PAPER_F6_V3_DESIGN.md) | **9%** |

**운영 코드 위치** (이 폴더 아님 — cron이 참조하므로 이동 금지):
- 신호/청산 로직·상태: `src/lib/paper-*-store.ts`, `src/lib/paper-funding-strategy.ts`
- cron tick: `scripts/paper-*-tick.ts`, `scripts/paper-*-backfill.ts`
- 대시보드: `src/app/page.tsx`, `src/app/api/paper-trading/`

> 핵심 결론(R47/R49): F6_v3가 chop(거짓돌파) 방어로 MDD 1/3(27→9%). F1F2↔F6 상관 0.08~0.16(무상관)이라 합성 시 MDD 반토막. 약세 방어 = 새 알고가 아니라 F6_v3 + 무상관 분산.

---

## archive — 보관 (미채택)

### specs/ — 옛 일봉 전략 (다른 프레임워크, 라이브 미적용)
C1_final / A4_panic50 / L1_low1 / P5_pool25 / AI_Gate_V1 — 일봉 진입·청산, 자본20%×5종 기반 초기 세대. 상세는 [archive/specs/README.md](archive/specs/README.md). PAPER_R19_5_PRIME 설계문서도 여기.

### research/ — 백테스트 스크립트 (r1~r49)
4h/일봉 모멘텀·펀딩·perp 등 전 실험. 헬퍼 `_candle-cache.ts`(캔들 캐시 로더), `_safe.ts`, `_fetch-binance-*.ts` 포함.
- 실행: `npx tsx algorithms/archive/research/<script>.ts`
- 데이터: `data/candle-cache/` (Upbit 4h, gitignore)
- 결과 dump: `data/research/*.txt` (gitignore — 용량 커서 미커밋)
- 주요: r43(두 가설 4년), r45*(F6_v3 검증), r46(약세 regime 필터 — 실패), r47(F6_v2 vs F6_v3), r48(변동성 사이징), r49(F1F2↔F6 상관)

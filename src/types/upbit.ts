/** 업비트 마켓 코드 */
export interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
  market_event: {
    warning: boolean;
    caution: {
      PRICE_FLUCTUATIONS: boolean;
      TRADING_VOLUME_SOARING: boolean;
      DEPOSIT_AMOUNT_SOARING: boolean;
      GLOBAL_PRICE_DIFFERENCES: boolean;
      CONCENTRATION_OF_SMALL_ACCOUNTS: boolean;
    };
  } | null;
}

/** 업비트 현재가 (ticker) */
export interface UpbitTicker {
  market: string;
  trade_date: string;
  trade_time: string;
  trade_date_kst: string;
  trade_time_kst: string;
  trade_timestamp: number;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  prev_closing_price: number;
  change: 'RISE' | 'EVEN' | 'FALL';
  change_price: number;
  change_rate: number;
  signed_change_price: number;
  signed_change_rate: number;
  trade_volume: number;
  acc_trade_price: number;
  acc_trade_price_24h: number;
  acc_trade_volume: number;
  acc_trade_volume_24h: number;
  highest_52_week_price: number;
  highest_52_week_date: string;
  lowest_52_week_price: number;
  lowest_52_week_date: string;
  timestamp: number;
}

/** 업비트 캔들 (분/일/주/월 공통 필드) */
export interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
  /** 분 캔들 전용 */
  unit?: number;
}

/** 업비트 일봉 캔들 (추가 필드) */
export interface UpbitDayCandle extends UpbitCandle {
  prev_closing_price: number;
  change_price: number;
  change_rate: number;
  converted_trade_price: number | null;
}

/** 호가 단위 */
export interface UpbitOrderbookUnit {
  ask_price: number;
  bid_price: number;
  ask_size: number;
  bid_size: number;
}

/** 업비트 호가 */
export interface UpbitOrderbook {
  market: string;
  timestamp: number;
  total_ask_size: number;
  total_bid_size: number;
  orderbook_units: UpbitOrderbookUnit[];
  level: number;
}

/** 업비트 계좌 정보 */
export interface UpbitAccount {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
}

/** 분 캔들 단위 */
export type CandleMinuteUnit = 1 | 3 | 5 | 15 | 10 | 30 | 60 | 240;

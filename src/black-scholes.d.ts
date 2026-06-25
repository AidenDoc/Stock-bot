// Minimal typings for the `black-scholes` npm package (no bundled types).
// blackScholes(s, k, t, v, r, callPut) → theoretical option price.
//   s = underlying price, k = strike, t = time to expiry in YEARS,
//   v = annualized volatility (e.g. 0.5 = 50%), r = risk-free rate,
//   callPut = 'call' | 'put'. Returns intrinsic value when t <= 0.
declare module 'black-scholes' {
  export function blackScholes(
    s: number, k: number, t: number, v: number, r: number, callPut: 'call' | 'put',
  ): number;
  export function stdNormCDF(x: number): number;
}

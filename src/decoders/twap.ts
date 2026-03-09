import { decodeAbiParameters, type Hex } from "viem";

export interface TwapDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  partSellAmount: string;
  minPartLimit: string;
  t0: string;
  n: string;
  t: string;
  span: string;
  appData: string;
}

const TWAP_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",      type: "address" },
      { name: "buyToken",       type: "address" },
      { name: "receiver",       type: "address" },
      { name: "partSellAmount", type: "uint256" },
      { name: "minPartLimit",   type: "uint256" },
      { name: "t0",             type: "uint256" },
      { name: "n",              type: "uint256" },
      { name: "t",              type: "uint256" },
      { name: "span",           type: "uint256" },
      { name: "appData",        type: "bytes32" },
    ],
  },
] as const;

export function decodeTwapStaticInput(staticInput: Hex): TwapDecodedParams {
  const [d] = decodeAbiParameters(TWAP_ABI, staticInput);
  return {
    sellToken:      d.sellToken.toLowerCase(),
    buyToken:       d.buyToken.toLowerCase(),
    receiver:       d.receiver.toLowerCase(),
    partSellAmount: d.partSellAmount.toString(),
    minPartLimit:   d.minPartLimit.toString(),
    t0:             d.t0.toString(),
    n:              d.n.toString(),
    t:              d.t.toString(),
    span:           d.span.toString(),
    appData:        d.appData,
  };
}

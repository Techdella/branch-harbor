/** Photography from Unsplash contributors (see footer credit). Reused from design/prototype. */
const U = (id: string, w = 1200) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

export const IMG = {
  yogaStudio: U('1761035190790-aa1a3472f7fc'),
  yogaStretch: U('1761035005546-62b8018b212a'),
  yogaGroup: U('1677741447985-da1d90c00742'),
  yogaRoom: U('1676496962536-d8ef110ff6f0'),
  yogaMeditate: U('1697274834392-04ff3b76ef20', 900),
  sportKids: U('1622659097509-4d56de14539e'),
  sportChildren: U('1526232761682-d26e03ac148e'),
  sportCoach: U('1574772135913-d519461c3996', 900),
  sportCones: U('1650897877790-0e171d2207dc', 900),
  spaProne: U('1544161515-4ab6ce6db874'),
  spaStones: U('1600334089648-b0d9d3028eb2', 900),
  spaDiffuser: U('1620733723572-11c53f73a416', 900),
  shopInterior: U('1441986300917-64674bd600d8'),
  shopBoutique: U('1441984904996-e0b6ba687e04', 900),
  shopPay: U('1556740738-b6a63e27c4df'),
  shopOpen: U('1472851294608-062f824d29cc', 900),
  foodChef: U('1622021142947-da7dedc7c39a'),
  foodCook: U('1640583342012-4622f31b650d', 900),
  foodTeam: U('1651977560788-98792cd34da0'),
  foodPizza: U('1651981075280-9a9e01acbff0', 900),
  realtyHouse: U('1600585154340-be6161a56a0c'),
  realtyLiving: U('1600566753190-17f0baa2a6c3', 900),
  hotelRoom: U('1631049307264-da0ec9d70304'),
  hotelSuite: U('1590490360182-c33d57733427', 900),
  hotelPool: U('1566073771259-6a8506099945'),
  team: U('1522202176988-66273c2fd55f'),
  meeting: U('1556157382-97eda2d62296'),
} as const;

/** Pastel tiles (tokens: lilac, butter, blush, aqua, mint, lime-soft). */
export const PASTEL = {
  lilac: '#E9DDF8',
  lime: '#E2F5A6',
  sage: '#D4E6D9',
  butter: '#F7EDA8',
  blush: '#F8D6D8',
  aqua: '#CDEEEE',
  sand: '#EFE3D3',
  canvas: '#F3F2EE',
  signal: '#D6F26B',
} as const;
export type PastelKey = keyof typeof PASTEL;

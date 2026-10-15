/** Generic product imagery (stock photos) used for brand heroes and location cards until a business uploads its own. */
const u = (id: string, w = 900) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

export const IMG = {
  yogaGroup: u('1677741447985-da1d90c00742'),
  yogaStudio: u('1761035190790-aa1a3472f7fc', 600),
  yogaStretch: u('1761035005546-62b8018b212a', 600),
  yogaFloor: u('1644612105654-b6b0a941ecde', 600),
  yogaRoom: u('1676496962536-d8ef110ff6f0', 600),
  yogaHands: u('1608405059861-b21a68ae76a2', 600),
  yogaPink: u('1588286840104-8957b019727f', 500),
  yogaMeditate: u('1697274834392-04ff3b76ef20', 500),
  yogaRed: u('1625865020971-581242d0ead6', 500),
  foodTeam: u('1651977560788-98792cd34da0'),
  foodChef: u('1622021142947-da7dedc7c39a', 600),
  foodCook: u('1640583342012-4622f31b650d', 600),
  foodPizza: u('1651981075280-9a9e01acbff0', 600),
  foodTomato: u('1554997433-8e233c02c751', 600),
  foodOven: u('1682071308247-04c65c28bba5', 600),
};

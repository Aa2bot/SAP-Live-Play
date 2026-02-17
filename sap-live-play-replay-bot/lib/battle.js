const { PETS, PERKS, TOYS } = require('./data');
const { PLACEHOLDER_SPRITE, PLACEHOLDER_PERK } = require('./config');

function getPetInfo(petJSON) {
  const petId = Number(petJSON["Enu"] ?? 0);
  const petName = PETS[petId] ? PETS[petId].Name : "Token Pet";
  const petLevel = petJSON["Lvl"];
  const petExperience = petJSON["Exp"] ?? 0;
  const petAtk = petJSON["At"]["Perm"];
  const petHp = petJSON["Hp"]["Perm"];
  const petTempAtk = petJSON["At"]["Temp"] ?? 0;
  const petTempHp = petJSON["Hp"]["Temp"] ?? 0;
  const petPerkId = petJSON["Perk"] ?? -1;
  const petImagePath = PETS[petId] ? `Sprite/Pets/${PETS[petId].NameId}.png` : PLACEHOLDER_SPRITE;
  if (petPerkId === -1) {
    return {
      name: petName,
      attack: petAtk,
      health: petHp,
      tempAttack: petTempAtk,
      tempHealth: petTempHp,
      level: petLevel,
      xp: petExperience,
      perk: null,
      imagePath: petImagePath,
      perkImagePath: null
    };
  }
  const perkName = PERKS[petPerkId] ? PERKS[petPerkId].Name : "UNKNOWN PERK";
  const perkImage = PERKS[petPerkId] ? `Sprite/Food/${PERKS[petPerkId].NameId}.png` : PLACEHOLDER_PERK;
  return {
    name: petName,
    attack: petAtk,
    health: petHp,
    tempAttack: petTempAtk,
    tempHealth: petTempHp,
    level: petLevel,
    xp: petExperience,
    perk: perkName,
    imagePath: petImagePath,
    perkImagePath: perkImage
  };
}

function getBattleInfo(battle) {
  const newBattle = {};
  newBattle.playerBoard = {
    boardPets: [],
    toy: {
      imagePath: null,
      level: 0
    }
  };

  newBattle.oppBoard = {
    boardPets: [],
    toy: {
      imagePath: null,
      level: 0
    }
  };

  newBattle.outcome = battle["Outcome"];
  newBattle.opponentName = battle["Opponent"]["DisplayName"];

  for (const petJSON of battle["UserBoard"]["Mins"]["Items"]) {
    if (petJSON !== null) {
      newBattle.playerBoard.boardPets.push(getPetInfo(petJSON));
    }
  }

  for (const toy of battle["UserBoard"]["Rel"]["Items"]) {
    if (toy !== null && toy["Enu"]) {
      const toyId = toy["Enu"];
      newBattle.playerBoard.toy.imagePath = TOYS[toyId] ? `Sprite/Toys/${TOYS[toyId].NameId}.png` : PLACEHOLDER_SPRITE;
      newBattle.playerBoard.toy.level = toy["Lvl"];
    }
  }

  for (const petJSON of battle["OpponentBoard"]["Mins"]["Items"]) {
    if (petJSON !== null) {
      newBattle.oppBoard.boardPets.push(getPetInfo(petJSON));
    }
  }

  for (const toy of battle["OpponentBoard"]["Rel"]["Items"]) {
    if (toy !== null && toy["Enu"]) {
      const toyId = toy["Enu"];
      newBattle.oppBoard.toy.imagePath = TOYS[toyId] ? `Sprite/Toys/${TOYS[toyId].NameId}.png` : PLACEHOLDER_SPRITE;
      newBattle.oppBoard.toy.level = toy["Lvl"];
    }
  }
  return newBattle;
}

module.exports = {
  getBattleInfo,
  getPetInfo
};

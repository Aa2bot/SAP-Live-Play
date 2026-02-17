const { API_VERSION } = require('./config');

let AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjEwMGE3YTVlLWNlMTItNDU5MC05ZTEwLTE0MmViOWY3ZTkwMSIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJMR1RZUVoiLCJqdGkiOiIyYTc0MmQwYy0wNGU4LTQyN2MtOWVjMC1kY2NiZjU1MDBlNTIiLCJleHAiOjE3NTM1MTM0OTAsImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsImF1ZCI6IioifQ.H-gnWFes3Qyie-VPzuBcK94voFZ1jx5KMv1B3GsaXM4";

async function login() {
  const loginToken = await fetch(`https://api.teamwood.games/0.${API_VERSION}/api/user/login`, {
    method: "POST",
    body: JSON.stringify({
      Email: process.env.SAP_EMAIL,
      Password: process.env.SAP_PASSWORD,
      Version: API_VERSION
    }),
    headers: {
      "Content-Type": "application/json; utf-8",
      authority: "api.teamwood.games"
    }
  });
  if (loginToken.ok) {
    const responseJSON = await loginToken.json();
    AUTH_TOKEN = responseJSON["Token"];
    console.log("Ready! Logged in");
  }
}

function getAuthToken() {
  return AUTH_TOKEN;
}

async function fetchReplay(participationId) {
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      Authority: "api.teamwood.games",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ParticipationId: participationId,
      Turn: 1,
      Version: API_VERSION
    })
  };
  return fetch(`https://api.teamwood.games/0.${API_VERSION}/api/playback/participation`, options);
}

module.exports = {
  login,
  getAuthToken,
  fetchReplay
};

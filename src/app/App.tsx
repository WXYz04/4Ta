import { Navigate, Route, Routes } from "react-router-dom";
import { WelcomePage } from "../features/onboarding/WelcomePage";
import { CreateTaPage } from "../features/onboarding/CreateTaPage";
import { CreateYouPage } from "../features/onboarding/CreateYouPage";
import { HomePage } from "../features/home/HomePage";
import { ChatPage } from "../features/chat/ChatPage";
import { EditProfileFieldPage, ProfilePage } from "../features/profile/ProfilePage";
import { ChatBackgroundPage, ChatPersonalizationPage, ChatSettingsPage, ReplySettingsPage } from "../features/settings/ChatSettingsPage";
import { ApiSettingsPage } from "../features/settings/ApiSettingsPage";
import { AccountEntryPage, AccountManagementPage, ChangePasswordPage } from "../features/account/AccountPage";
import { CloudSyncBridge } from "../services/CloudSyncBridge";
import { WorldBookEditorPage, WorldBookPage } from "../features/worldbook/WorldBookPages";
import { StickerEditorPage, StickerManagementPage } from "../features/stickers/StickerPages";
import { NotificationSettingsPage } from "../features/settings/NotificationSettingsPage";
import { CreateMomentPage, MomentsPage } from "../features/moments/MomentsPage";
import { CreateGroupPage, GroupChatPage } from "../features/groups/GroupPages";
import { CharacterEditorPage, CharacterManagementPage } from "../features/characters/CharacterManagementPages";
import { TransferPage, WalletPage } from "../features/wallet/WalletPages";
import { RedPacketCreatePage, RedPacketDetailPage } from "../features/wallet/RedPacketPages";
import { MemoryGalaxyPage } from "../features/memory/MemoryGalaxyPage";
import { MeetingHistoryDetailPage, MeetingHistoryPage, MeetingPlayPage, MeetingSettingsPage } from "../features/meetings/MeetingPages";
import { TravelAppPage, TravelTicketPage } from "../features/meetings/TravelPages";
import { HeartHouseCastPage, HeartHouseDetailPage, HeartHouseGamePage, HeartHouseLoadingPage, SpacesPage } from "../features/spaces/SpacePages";
import { ConquestCastPage, ConquestPlayPage, ConquestRoleSetupPage } from "../features/spaces/ConquestPages";
import { TaPhonePage } from "../features/phone/TaPhonePage";

function LegacyAccountOnboardingGuard({ children }: { children: React.ReactNode }) {
  const account = (localStorage.getItem("4ta:account-name") || "").trim().toLocaleLowerCase();
  if (account === "wen304") return <Navigate to="/home" replace />;
  return children;
}

export function App() {
  return (
    <>
    <CloudSyncBridge />
    <Routes>
      <Route path="/" element={<AccountEntryPage />} />
      <Route path="/welcome" element={<LegacyAccountOnboardingGuard><WelcomePage /></LegacyAccountOnboardingGuard>} />
      <Route path="/create/ta" element={<LegacyAccountOnboardingGuard><CreateTaPage /></LegacyAccountOnboardingGuard>} />
      <Route path="/create/you" element={<LegacyAccountOnboardingGuard><CreateYouPage /></LegacyAccountOnboardingGuard>} />
      <Route path="/home" element={<HomePage />} />
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/chat/:taId" element={<ChatPage />} />
      <Route path="/chat/:taId/memory-galaxy" element={<MemoryGalaxyPage />} />
      <Route path="/chat/:taId/transfer" element={<TransferPage />} />
      <Route path="/chat/:taId/red-packet" element={<RedPacketCreatePage />} />
      <Route path="/chat/:taId/phone" element={<TaPhonePage />} />
      <Route path="/group/:groupId/red-packet" element={<RedPacketCreatePage />} />
      <Route path="/red-packet/:packetId" element={<RedPacketDetailPage />} />
      <Route path="/account/wallet" element={<WalletPage />} />
      <Route path="/meeting/play/:sessionId" element={<MeetingPlayPage />} />
      <Route path="/meeting/settings/:sessionId" element={<MeetingSettingsPage />} />
      <Route path="/meeting/history" element={<MeetingHistoryPage />} />
      <Route path="/meeting/history/:sessionId" element={<MeetingHistoryDetailPage />} />
      <Route path="/travel" element={<TravelAppPage />} />
      <Route path="/travel/ticket/:ticketId" element={<TravelTicketPage />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route path="/spaces/heart-house" element={<HeartHouseDetailPage />} />
      <Route path="/spaces/heart-house/cast" element={<HeartHouseCastPage />} />
      <Route path="/spaces/heart-house/loading" element={<HeartHouseLoadingPage />} />
      <Route path="/spaces/heart-house/play" element={<HeartHouseGamePage />} />
      <Route path="/spaces/reverse-conquest" element={<ConquestCastPage />} />
      <Route path="/spaces/reverse-conquest/setup/:taId" element={<ConquestRoleSetupPage />} />
      <Route path="/spaces/reverse-conquest/play/:taId" element={<ConquestPlayPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/profile/edit/:field" element={<EditProfileFieldPage />} />
      <Route path="/settings/chat" element={<ChatSettingsPage />} />
      <Route path="/settings/chat/background" element={<ChatBackgroundPage />} />
      <Route path="/settings/chat/reply" element={<ReplySettingsPage />} />
      <Route path="/settings/chat/personalization" element={<ChatPersonalizationPage />} />
      <Route path="/settings/api" element={<ApiSettingsPage />} />
      <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
      <Route path="/settings/account" element={<AccountManagementPage />} />
      <Route path="/settings/account/password" element={<ChangePasswordPage />} />
      <Route path="/worldbook" element={<WorldBookPage />} />
      <Route path="/worldbook/new" element={<WorldBookEditorPage />} />
      <Route path="/worldbook/:id" element={<WorldBookEditorPage />} />
      <Route path="/settings/chat/stickers" element={<StickerManagementPage />} />
      <Route path="/settings/chat/stickers/new" element={<StickerEditorPage />} />
      <Route path="/settings/chat/stickers/:id" element={<StickerEditorPage />} />
      <Route path="/moments" element={<MomentsPage />} />
      <Route path="/moments/new" element={<CreateMomentPage />} />
      <Route path="/moments/:scope" element={<MomentsPage />} />
      <Route path="/groups/new" element={<CreateGroupPage />} />
      <Route path="/group/:groupId" element={<GroupChatPage />} />
      <Route path="/characters" element={<CharacterManagementPage />} />
      <Route path="/characters/:taId" element={<CharacterEditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

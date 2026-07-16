'use strict';

const { createTeamManagementService } = require('../services/teamManagementService');

const teamManagementService = createTeamManagementService();

exports.listTeams = async (req, res, next) => {
  try {
    const teams = await teamManagementService.listTeams({
      authContext: req.authContext,
      status: req.query.status
    });
    return res.json({ teams });
  } catch (error) {
    return next(error);
  }
};

exports.createTeam = async (req, res, next) => {
  try {
    const team = await teamManagementService.createTeam({
      authContext: req.authContext,
      req,
      input: req.body || {}
    });
    return res.status(201).json({
      message: 'Team created',
      team
    });
  } catch (error) {
    return next(error);
  }
};

exports.enableTeam = async (req, res, next) => {
  try {
    const team = await teamManagementService.enableTeam({
      authContext: req.authContext,
      req,
      teamId: req.params.teamId,
      input: req.body || {}
    });
    return res.json({
      message: 'Team enabled',
      team
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateTeamStatus = async (req, res, next) => {
  try {
    const team = await teamManagementService.updateTeamStatus({
      authContext: req.authContext,
      req,
      teamId: req.params.teamId,
      input: req.body || {}
    });
    return res.json({
      message: 'Team status updated',
      team
    });
  } catch (error) {
    return next(error);
  }
};
